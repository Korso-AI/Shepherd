import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isDeclined,
  setDeclined,
  clearDeclined,
  declinedFilePath,
} from "../src/declined.js";

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe("declined", () => {
  it("is false for a never-declined repo", () => {
    const declinedDir = mkTmp("declined-none-");
    const repo = mkTmp("repo-a-");
    expect(isDeclined(repo, declinedDir)).toBe(false);
  });

  it("setDeclined then isDeclined is true; clearDeclined then isDeclined is false", () => {
    const declinedDir = mkTmp("declined-set-");
    const repo = mkTmp("repo-b-");

    expect(isDeclined(repo, declinedDir)).toBe(false);
    setDeclined(repo, declinedDir);
    expect(isDeclined(repo, declinedDir)).toBe(true);

    clearDeclined(repo, declinedDir);
    expect(isDeclined(repo, declinedDir)).toBe(false);
  });

  it("writes a readable JSON audit trail with declinedAt", () => {
    const declinedDir = mkTmp("declined-audit-");
    const repo = mkTmp("repo-c-");

    setDeclined(repo, declinedDir);
    const file = declinedFilePath(repo, declinedDir);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      declinedAt?: unknown;
    };
    expect(typeof parsed.declinedAt).toBe("string");
  });

  it("two different repo roots don't collide", () => {
    const declinedDir = mkTmp("declined-collide-");
    const repoA = mkTmp("repo-d-");
    const repoB = mkTmp("repo-e-");

    setDeclined(repoA, declinedDir);
    expect(isDeclined(repoA, declinedDir)).toBe(true);
    expect(isDeclined(repoB, declinedDir)).toBe(false);
    expect(declinedFilePath(repoA, declinedDir)).not.toBe(
      declinedFilePath(repoB, declinedDir),
    );
  });

  it("fails open: an unreadable/garbage file returns false without throwing", () => {
    const declinedDir = mkTmp("declined-garbage-");
    const repo = mkTmp("repo-f-");

    const file = declinedFilePath(repo, declinedDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json ");

    expect(() => isDeclined(repo, declinedDir)).not.toThrow();
    expect(isDeclined(repo, declinedDir)).toBe(false);
  });

  it("setDeclined fails open under an un-creatable path", () => {
    const declinedDir = mkTmp("declined-uncreatable-");
    const blocker = path.join(declinedDir, "blocker");
    fs.writeFileSync(blocker, "x");
    const repo = mkTmp("repo-g-");

    expect(() => setDeclined(repo, path.join(blocker, "nope"))).not.toThrow();
  });

  it("clearDeclined is idempotent when nothing was declined", () => {
    const declinedDir = mkTmp("declined-clear-absent-");
    const repo = mkTmp("repo-h-");
    expect(() => clearDeclined(repo, declinedDir)).not.toThrow();
    expect(isDeclined(repo, declinedDir)).toBe(false);
  });
});
