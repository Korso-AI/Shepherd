import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLinkNudge, LINK_NUDGE_TEXT } from "../src/linkNudge.js";
import { setDeclined } from "../src/declined.js";

// ---------------------------------------------------------------------------
// buildLinkNudge — the unlinked-repo soft nudge. The hook calls this on every
// invocation; it must return the nudge ONLY for a write in a repo that is
// neither linked (.shepherd marker) nor declined, and must be silent (and
// fail-open) everywhere else.
// ---------------------------------------------------------------------------

describe("buildLinkNudge", () => {
  let repo: string; // temp dir with a .git entry → a repo root
  let declinedDir: string; // hermetic declined store, never the real ~/.shepherd

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "shepherd-nudge-repo-"));
    mkdirSync(join(repo, ".git"));
    declinedDir = mkdtempSync(join(tmpdir(), "shepherd-nudge-declined-"));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(declinedDir, { recursive: true, force: true });
  });

  it("nudges on a write tool in an unlinked, undeclined repo", () => {
    for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      expect(buildLinkNudge(repo, tool, { declinedDir })).toBe(LINK_NUDGE_TEXT);
    }
  });

  it("nudges when no tool name is given (SessionStart / UserPromptSubmit)", () => {
    expect(buildLinkNudge(repo, undefined, { declinedDir })).toBe(LINK_NUDGE_TEXT);
  });

  it("nudges from a subdirectory of the repo (marker lookup walks up)", () => {
    const sub = join(repo, "packages", "thing");
    mkdirSync(sub, { recursive: true });
    expect(buildLinkNudge(sub, "Edit", { declinedDir })).toBe(LINK_NUDGE_TEXT);
  });

  it("is silent for read-only tools", () => {
    for (const tool of ["Read", "Grep", "Glob", "Bash", "mcp__shepherd__sync"]) {
      expect(buildLinkNudge(repo, tool, { declinedDir })).toBe("");
    }
  });

  it("is silent when the repo is linked (a .shepherd marker exists)", () => {
    writeFileSync(join(repo, ".shepherd"), JSON.stringify({ workspace: "acme" }) + "\n");
    expect(buildLinkNudge(repo, "Edit", { declinedDir })).toBe("");
  });

  it("is silent when the repo was declined", () => {
    setDeclined(repo, declinedDir);
    expect(buildLinkNudge(repo, "Edit", { declinedDir })).toBe("");
  });

  it("is silent outside a git repo", () => {
    const noRepo = mkdtempSync(join(tmpdir(), "shepherd-nudge-norepo-"));
    try {
      expect(buildLinkNudge(noRepo, "Edit", { declinedDir })).toBe("");
    } finally {
      rmSync(noRepo, { recursive: true, force: true });
    }
  });

  it("a garbled marker still nudges (treated as unlinked, per marker.ts fail-open)", () => {
    writeFileSync(join(repo, ".shepherd"), "not json");
    expect(buildLinkNudge(repo, "Edit", { declinedDir })).toBe(LINK_NUDGE_TEXT);
  });

  it("the nudge names the link and decline tools", () => {
    expect(LINK_NUDGE_TEXT).toContain("`link`");
    expect(LINK_NUDGE_TEXT).toContain("`decline`");
  });
});
