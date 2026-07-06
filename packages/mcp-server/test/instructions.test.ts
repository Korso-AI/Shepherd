import { describe, it, expect } from "vitest";
import { buildInstructions } from "../src/instructions.js";

describe("buildInstructions", () => {
  it("returns a non-empty string for every link state", () => {
    for (const state of ["linked", "declined", "unanswered"] as const) {
      const text = buildInstructions(state);
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
    }
  });

  describe("linked", () => {
    const text = buildInstructions("linked", "team-alpha");

    it("names every coordination verb so the agent knows its standing procedure", () => {
      for (const verb of ["work", "done", "announce", "sync"]) {
        expect(text).toContain(`\`${verb}\``);
      }
    });

    it("carries the full numbered procedure", () => {
      for (const step of ["1.", "2.", "3.", "4.", "5."]) {
        expect(text).toContain(step);
      }
      expect(text).toContain("read-only exploration");
      expect(text.toLowerCase()).toContain("commit");
    });

    it("steers glob scoping away from over-broad claims", () => {
      expect(text).toContain('["src/auth/**"]');
      expect(text).toContain('["src/**"]');
    });

    it("names the linked workspace so the agent knows where it coordinates", () => {
      expect(text).toContain("team-alpha");
    });

    it("does NOT carry the first-run ask — the link decision is settled", () => {
      expect(text).not.toContain("`decline`");
      expect(text.toLowerCase()).not.toContain("popup");
    });
  });

  describe("unanswered", () => {
    const text = buildInstructions("unanswered");

    it("explains the repo is not linked and Shepherd normally asks the user itself", () => {
      expect(text.toLowerCase()).toContain("isn't linked");
      // The popup/tripwire (not the agent) is the primary asker.
      expect(text.toLowerCase()).toMatch(/ask(s)? the user directly|popup/);
    });

    it("keeps the agent as fallback asker: link/decline ritual, at most once", () => {
      expect(text).toContain("`link`");
      expect(text).toContain("`decline`");
      expect(text.toLowerCase()).toContain("once");
    });

    it("does NOT front-load the full procedure (delivered on link instead)", () => {
      expect(text).not.toContain("workItemId");
      expect(text).not.toContain("pathGlobs");
    });
  });

  describe("declined", () => {
    const text = buildInstructions("declined");

    it("is one quiet paragraph, far shorter than the linked procedure", () => {
      expect(text.length).toBeLessThan(400);
      expect(text.length).toBeLessThan(buildInstructions("linked").length / 3);
    });

    it("tells the agent to stay quiet unless the user re-opens the topic via `link`", () => {
      expect(text.toLowerCase()).toContain("declined");
      expect(text).toContain("`link`");
      // Never nags: no ask ritual, no procedure verbs.
      expect(text).not.toContain("`decline`");
      expect(text).not.toContain("`work`");
      expect(text).not.toContain("`announce`");
    });
  });
});
