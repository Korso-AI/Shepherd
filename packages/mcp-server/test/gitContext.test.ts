import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  detectRepo,
  detectBranch,
  detectHuman,
  detectBaseBranch,
  headSha,
  unlandedCommits,
  dirtyPaths,
  isAncestor,
  hasCommit,
  changedLineRanges,
  canonicalizeRepo,
  MAX_PATHS_PER_COMMIT,
  MAX_LINE_RANGE_PATHS,
} from "../src/gitContext.js";

/** Run git in a dir, returning trimmed stdout. Throws on failure (test setup only). */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Create a throwaway dir under the OS temp dir. */
function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const tmpDirs: string[] = [];
function track(dir: string): string {
  tmpDirs.push(dir);
  return dir;
}

/** Initialize a deterministic git repo with a configured identity and origin. */
function initRepo(cwd: string, opts: { origin?: string; name?: string; email?: string } = {}): void {
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", opts.name ?? "Test User");
  git(cwd, "config", "user.email", opts.email ?? "tester@example.com");
  git(cwd, "config", "commit.gpgsign", "false");
  // Force a deterministic default branch name regardless of git version config.
  git(cwd, "checkout", "-q", "-B", "main");
  if (opts.origin !== undefined) {
    git(cwd, "remote", "add", "origin", opts.origin);
  }
}

function writeFile(cwd: string, rel: string, content: string): void {
  const full = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function commitAll(cwd: string, message: string): string {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

afterAll(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("detectRepo", () => {
  it("normalizes an https origin url to owner/repo", () => {
    const dir = track(mkTmp("gc-repo-https-"));
    initRepo(dir, { origin: "https://github.com/Acme/My-Repo.git" });
    expect(detectRepo(dir)).toBe("Acme/My-Repo");
  });

  it("normalizes an ssh (scp-like) origin url to owner/repo", () => {
    const dir = track(mkTmp("gc-repo-ssh-"));
    initRepo(dir, { origin: "git@github.com:Acme/My-Repo.git" });
    expect(detectRepo(dir)).toBe("Acme/My-Repo");
  });

  it("falls back to the toplevel basename when there is no origin", () => {
    const dir = track(mkTmp("gc-repo-noorigin-"));
    initRepo(dir);
    writeFile(dir, "a.txt", "hi");
    commitAll(dir, "init");
    const expected = path.basename(fs.realpathSync(dir));
    expect(detectRepo(dir)).toBe(expected);
  });

  it("returns null when not a git repo", () => {
    const dir = track(mkTmp("gc-repo-nogit-"));
    expect(detectRepo(dir)).toBeNull();
  });
});

describe("canonicalizeRepo (re-exported from @shepherd/shared)", () => {
  // Authoritative behaviour is tested in packages/shared/test/repo.test.ts.
  // Here we only assert the client re-exports the SAME function, so call sites
  // (resolveContext) keep importing it from gitContext.
  it("re-exports the shared bare-name canonicalizer", () => {
    expect(canonicalizeRepo("git@github.com:Acme/widgets.git")).toBe("widgets");
  });
});

describe("detectBranch", () => {
  it("returns the current branch name", () => {
    const dir = track(mkTmp("gc-branch-"));
    initRepo(dir);
    writeFile(dir, "a.txt", "hi");
    commitAll(dir, "init");
    expect(detectBranch(dir)).toBe("main");
  });

  it("returns HEAD when detached", () => {
    const dir = track(mkTmp("gc-branch-detached-"));
    initRepo(dir);
    writeFile(dir, "a.txt", "hi");
    const sha = commitAll(dir, "init");
    git(dir, "checkout", "-q", sha);
    expect(detectBranch(dir)).toBe("HEAD");
  });

  it("returns null when not a git repo", () => {
    const dir = track(mkTmp("gc-branch-nogit-"));
    expect(detectBranch(dir)).toBeNull();
  });
});

describe("detectHuman", () => {
  it("prefers user.name", () => {
    const dir = track(mkTmp("gc-human-name-"));
    initRepo(dir, { name: "Alice Example", email: "alice@example.com" });
    expect(detectHuman(dir)).toBe("Alice Example");
  });

  it("takes the local-part when user.name itself is set to an email address", () => {
    // A common misconfiguration: git user.name is the full email. The identity
    // should be the handle ("carol"), not "carol@example.com" — which would slug
    // to "carolexamplecom" on the hub.
    const dir = track(mkTmp("gc-human-name-email-"));
    initRepo(dir, { name: "carol@example.com", email: "carol@example.com" });
    expect(detectHuman(dir)).toBe("carol");
  });

  it("falls back to the local-part of user.email when name is unset", () => {
    const dir = track(mkTmp("gc-human-email-"));
    git(dir, "init", "-q");
    // Shadow any globally-configured user.name with a local empty value so the
    // email fallback is exercised deterministically on any machine.
    git(dir, "config", "user.name", "");
    git(dir, "config", "user.email", "bob@example.com");
    expect(detectHuman(dir)).toBe("bob");
  });

  it("returns null when not a git repo", () => {
    const dir = track(mkTmp("gc-human-nogit-"));
    expect(detectHuman(dir)).toBeNull();
  });
});

describe("detectBaseBranch", () => {
  it("resolves origin/HEAD when set", () => {
    const dir = track(mkTmp("gc-base-head-"));
    initRepo(dir, { origin: "https://github.com/Acme/Repo.git" });
    writeFile(dir, "a.txt", "hi");
    commitAll(dir, "init");
    // Simulate a fetched remote-tracking ref + origin/HEAD symbolic ref.
    git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    expect(detectBaseBranch(dir)).toBe("origin/main");
  });

  it("probes origin/master when origin/HEAD is absent", () => {
    const dir = track(mkTmp("gc-base-master-"));
    initRepo(dir);
    writeFile(dir, "a.txt", "hi");
    commitAll(dir, "init");
    git(dir, "update-ref", "refs/remotes/origin/master", "HEAD");
    expect(detectBaseBranch(dir)).toBe("origin/master");
  });

  it("returns null when not a git repo", () => {
    const dir = track(mkTmp("gc-base-nogit-"));
    expect(detectBaseBranch(dir)).toBeNull();
  });
});

describe("headSha", () => {
  it("returns the HEAD sha", () => {
    const dir = track(mkTmp("gc-head-"));
    initRepo(dir);
    writeFile(dir, "a.txt", "hi");
    const sha = commitAll(dir, "init");
    expect(headSha(dir)).toBe(sha);
  });

  it("returns null when not a git repo", () => {
    const dir = track(mkTmp("gc-head-nogit-"));
    expect(headSha(dir)).toBeNull();
  });
});

describe("unlandedCommits", () => {
  it("returns commits ahead of the base branch with shas, messages and paths", () => {
    const dir = track(mkTmp("gc-unlanded-"));
    initRepo(dir);
    writeFile(dir, "base.txt", "base");
    commitAll(dir, "base commit");
    // Record the base ref, then advance feature branch with two commits.
    git(dir, "branch", "base-ref");
    writeFile(dir, "feature-one.txt", "one");
    const sha1 = commitAll(dir, "feature one");
    writeFile(dir, "feature-two.txt", "two");
    const sha2 = commitAll(dir, "feature two");

    const result = unlandedCommits(dir, "base-ref");
    expect(result.truncated).toBe(false);
    expect(result.commits.length).toBe(2);
    // git log is newest-first.
    expect(result.commits[0].sha).toBe(sha2);
    expect(result.commits[0].message).toBe("feature two");
    expect(result.commits[0].paths).toContain("feature-two.txt");
    expect(result.commits[1].sha).toBe(sha1);
    expect(result.commits[1].message).toBe("feature one");
    expect(result.commits[1].paths).toContain("feature-one.txt");
  });

  it("returns an empty, non-truncated result on failure (not a repo)", () => {
    const dir = track(mkTmp("gc-unlanded-nogit-"));
    const result = unlandedCommits(dir, "origin/main");
    expect(result.commits).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("sets truncated:true when a single commit's path list exceeds the per-commit cap", () => {
    const dir = track(mkTmp("gc-unlanded-trunc-"));
    initRepo(dir);
    writeFile(dir, "base.txt", "base");
    commitAll(dir, "base commit");
    git(dir, "branch", "base-ref");
    // One commit touching more than MAX_PATHS_PER_COMMIT files trips the cap.
    const fileCount = MAX_PATHS_PER_COMMIT + 1;
    for (let i = 0; i < fileCount; i++) {
      writeFile(dir, `f/${i}.txt`, `content ${i}`);
    }
    commitAll(dir, "many files");

    const result = unlandedCommits(dir, "base-ref");
    expect(result.truncated).toBe(true);
    expect(result.commits.length).toBe(1);
    expect(result.commits[0].paths.length).toBe(MAX_PATHS_PER_COMMIT);
  });

  it("drops commits with no file lines (e.g. empty/merge commits) so paths is never empty", () => {
    const dir = track(mkTmp("gc-unlanded-empty-"));
    initRepo(dir);
    writeFile(dir, "base.txt", "base");
    commitAll(dir, "base commit");
    git(dir, "branch", "base-ref");
    // A real file-bearing commit...
    writeFile(dir, "feature.txt", "feat");
    const realSha = commitAll(dir, "real feature");
    // ...and an empty commit (no file lines emitted by --name-only).
    git(dir, "commit", "-q", "--allow-empty", "-m", "empty commit");

    const result = unlandedCommits(dir, "base-ref");
    // No entry may have empty paths — the empty commit is dropped entirely.
    expect(result.commits.every((c) => c.paths.length > 0)).toBe(true);
    // The real file-bearing commit survives.
    const real = result.commits.find((c) => c.sha === realSha);
    expect(real).toBeDefined();
    expect(real!.paths).toContain("feature.txt");
    // The empty commit's message is not present.
    expect(result.commits.some((c) => c.message === "empty commit")).toBe(false);
  });

  it("returns the neutral result without spawning git for a flag-like base branch", () => {
    const dir = track(mkTmp("gc-unlanded-flag-"));
    initRepo(dir);
    writeFile(dir, "a.txt", "hi");
    commitAll(dir, "init");
    // A baseBranch beginning with "-" or empty is rejected defensively.
    expect(unlandedCommits(dir, "--all")).toEqual({ commits: [], truncated: false });
    expect(unlandedCommits(dir, "-foo")).toEqual({ commits: [], truncated: false });
    expect(unlandedCommits(dir, "")).toEqual({ commits: [], truncated: false });
  });
});

describe("dirtyPaths", () => {
  it("lists modified and untracked paths, deduped", () => {
    const dir = track(mkTmp("gc-dirty-"));
    initRepo(dir);
    writeFile(dir, "tracked.txt", "v1");
    commitAll(dir, "init");
    writeFile(dir, "tracked.txt", "v2"); // modified
    writeFile(dir, "untracked.txt", "new"); // untracked
    const result = dirtyPaths(dir);
    expect(result.truncated).toBe(false);
    expect(result.paths).toContain("tracked.txt");
    expect(result.paths).toContain("untracked.txt");
    // deduped
    expect(new Set(result.paths).size).toBe(result.paths.length);
  });

  it("captures both endpoints of a staged rename (R parsing branch)", () => {
    const dir = track(mkTmp("gc-dirty-rename-"));
    initRepo(dir);
    writeFile(dir, "old-name.txt", "stable content");
    commitAll(dir, "init");
    // git mv stages a rename; porcelain reports it as "R  old\0new" (-z).
    git(dir, "mv", "old-name.txt", "new-name.txt");
    const result = dirtyPaths(dir);
    expect(result.truncated).toBe(false);
    expect(result.paths).toContain("old-name.txt");
    expect(result.paths).toContain("new-name.txt");
  });

  it("returns empty, non-truncated on failure (not a repo)", () => {
    const dir = track(mkTmp("gc-dirty-nogit-"));
    const result = dirtyPaths(dir);
    expect(result.paths).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});

describe("isAncestor", () => {
  it("returns true for a commit on the base, false for an unmerged feature commit, false for bogus", () => {
    const dir = track(mkTmp("gc-ancestor-"));
    initRepo(dir);
    writeFile(dir, "a.txt", "base");
    const baseSha = commitAll(dir, "base");
    git(dir, "checkout", "-q", "-b", "feature");
    writeFile(dir, "b.txt", "feat");
    const featSha = commitAll(dir, "feat");
    // Go back to main; feature commit is NOT an ancestor of main HEAD.
    git(dir, "checkout", "-q", "main");

    expect(isAncestor(dir, baseSha)).toBe(true);
    expect(isAncestor(dir, featSha)).toBe(false);
    expect(isAncestor(dir, "0".repeat(40))).toBe(false);
  });

  it("returns false when not a git repo", () => {
    const dir = track(mkTmp("gc-ancestor-nogit-"));
    expect(isAncestor(dir, "0".repeat(40))).toBe(false);
  });

  it("rejects a flag-like / non-hex sha without writing a file (SEC-1 arg-injection guard)", () => {
    const dir = track(mkTmp("gc-ancestor-inject-"));
    initRepo(dir);
    writeFile(dir, "a.txt", "base");
    commitAll(dir, "base");
    const pwn = path.join(dir, "pwned.txt");
    // `git diff --output=<file>` would write a file if the value were passed as a
    // rev; the guard must reject it (and never spawn git with it).
    expect(isAncestor(dir, `--output=${pwn}`)).toBe(false);
    expect(hasCommit(dir, `--output=${pwn}`)).toBe(false);
    expect(changedLineRanges(dir, `--output=${pwn}`, ["a.txt"])).toEqual({});
    expect(isAncestor(dir, "HEAD")).toBe(false); // non-hex ref form rejected too
    expect(fs.existsSync(pwn)).toBe(false);
  });
});

describe("hasCommit", () => {
  it("returns true for a local commit and false for a fabricated sha", () => {
    const dir = track(mkTmp("gc-hascommit-"));
    initRepo(dir);
    writeFile(dir, "a.txt", "hi");
    const sha = commitAll(dir, "init");
    expect(hasCommit(dir, sha)).toBe(true);
    expect(hasCommit(dir, "0".repeat(40))).toBe(false);
  });

  it("returns false when not a git repo", () => {
    const dir = track(mkTmp("gc-hascommit-nogit-"));
    expect(hasCommit(dir, "0".repeat(40))).toBe(false);
  });
});

describe("changedLineRanges", () => {
  it("yields a range covering edited lines 12-45 of a file", () => {
    const dir = track(mkTmp("gc-ranges-"));
    initRepo(dir);
    // 60 numbered lines.
    const original = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    writeFile(dir, "file.txt", original);
    commitAll(dir, "init 60 lines");
    // Edit lines 12..45 in place (same line count, content changed).
    const lines = original.split("\n");
    for (let i = 11; i <= 44; i++) {
      lines[i] = `CHANGED ${i + 1}`;
    }
    writeFile(dir, "file.txt", lines.join("\n"));
    const sha = commitAll(dir, "edit 12-45");

    const ranges = changedLineRanges(dir, sha, ["file.txt"]);
    expect(ranges["file.txt"]).toBeDefined();
    const r = ranges["file.txt"];
    const minStart = Math.min(...r.map((x) => x.start));
    const maxEnd = Math.max(...r.map((x) => x.end));
    expect(minStart).toBeLessThanOrEqual(12);
    expect(maxEnd).toBeGreaterThanOrEqual(45);
  });

  it("handles a root commit (no parent) via fallback", () => {
    const dir = track(mkTmp("gc-ranges-root-"));
    initRepo(dir);
    const content = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    writeFile(dir, "root.txt", content);
    const sha = commitAll(dir, "root commit");
    const ranges = changedLineRanges(dir, sha, ["root.txt"]);
    expect(ranges["root.txt"]).toBeDefined();
    expect(ranges["root.txt"].length).toBeGreaterThan(0);
  });

  it("caps the number of paths it processes to avoid a git-spawn fan-out", () => {
    const dir = track(mkTmp("gc-ranges-cap-"));
    initRepo(dir);
    const total = MAX_LINE_RANGE_PATHS + 5;
    for (let i = 0; i < total; i++) {
      writeFile(dir, `r/${i}.txt`, `line a\nline b\n`);
    }
    const sha = commitAll(dir, "many files");
    const allPaths = Array.from({ length: total }, (_, i) => `r/${i}.txt`);
    const ranges = changedLineRanges(dir, sha, allPaths);
    // Only the first MAX_LINE_RANGE_PATHS paths are processed; the rest are ignored.
    expect(Object.keys(ranges).length).toBeLessThanOrEqual(MAX_LINE_RANGE_PATHS);
    expect(ranges["r/0.txt"]).toBeDefined();
    expect(ranges[`r/${total - 1}.txt`]).toBeUndefined();
    // Raised timeout: this test deliberately spawns the capped maximum of
    // serial `git` calls (up to MAX_LINE_RANGE_PATHS × 2), which is slow on
    // Windows where process spawn cost is high. 5s is too tight on slow CI.
  }, 30000);

  it("returns {} when not a git repo", () => {
    const dir = track(mkTmp("gc-ranges-nogit-"));
    expect(changedLineRanges(dir, "0".repeat(40), ["x.txt"])).toEqual({});
  });
});

describe("fail-open behaviour in a non-git directory", () => {
  it("every wrapper returns its neutral value and never throws", () => {
    const dir = track(mkTmp("gc-failopen-"));
    expect(() => {
      expect(detectRepo(dir)).toBeNull();
      expect(detectBranch(dir)).toBeNull();
      expect(detectHuman(dir)).toBeNull();
      expect(detectBaseBranch(dir)).toBeNull();
      expect(headSha(dir)).toBeNull();
      expect(unlandedCommits(dir, "origin/main")).toEqual({ commits: [], truncated: false });
      expect(dirtyPaths(dir)).toEqual({ paths: [], truncated: false });
      expect(isAncestor(dir, "0".repeat(40))).toBe(false);
      expect(hasCommit(dir, "0".repeat(40))).toBe(false);
      expect(changedLineRanges(dir, "0".repeat(40), ["x.txt"])).toEqual({});
    }).not.toThrow();
  });
});
