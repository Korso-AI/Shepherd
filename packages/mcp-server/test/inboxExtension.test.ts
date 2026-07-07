import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProcedureInjection } from "../src/inboxExtension.js";
import { buildInstructions } from "../src/instructions.js";

// ---------------------------------------------------------------------------
// buildProcedureInjection — the Pi-specific analogue of the MCP `instructions`
// field. Pi's client discards that field (unlike Claude Code), so the Pi
// extension re-delivers the SAME standing procedure text by appending it to
// the system prompt on every `before_agent_start`. Only the "linked" case
// injects here — the unlinked/declined first-run ask is already covered by
// buildLinkNudge's per-turn message, and duplicating it in the system prompt
// too would be redundant noise.
// ---------------------------------------------------------------------------

describe("buildProcedureInjection", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "shepherd-procedure-repo-"));
    mkdirSync(join(repo, ".git"));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("injects the full linked-state procedure when the repo has a .shepherd marker", () => {
    writeFileSync(
      join(repo, ".shepherd"),
      JSON.stringify({ workspace: "acme" }) + "\n",
    );
    expect(buildProcedureInjection(repo)).toBe(
      buildInstructions("linked", "acme"),
    );
  });

  it("resolves from a subdirectory of the repo (marker lookup walks up)", () => {
    writeFileSync(
      join(repo, ".shepherd"),
      JSON.stringify({ workspace: "acme" }) + "\n",
    );
    const sub = join(repo, "packages", "thing");
    mkdirSync(sub, { recursive: true });
    expect(buildProcedureInjection(sub)).toBe(
      buildInstructions("linked", "acme"),
    );
  });

  it("is empty when the repo has no .shepherd marker (unanswered is handled by the nudge instead)", () => {
    expect(buildProcedureInjection(repo)).toBe("");
  });

  it("is empty outside a git repo", () => {
    const noRepo = mkdtempSync(join(tmpdir(), "shepherd-procedure-norepo-"));
    try {
      expect(buildProcedureInjection(noRepo)).toBe("");
    } finally {
      rmSync(noRepo, { recursive: true, force: true });
    }
  });

  it("is empty when the marker is garbled (fail-open to unlinked, per marker.ts)", () => {
    writeFileSync(join(repo, ".shepherd"), "not json");
    expect(buildProcedureInjection(repo)).toBe("");
  });
});
