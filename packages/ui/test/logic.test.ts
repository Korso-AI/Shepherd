/**
 * Characterization tests for the wallboard's pure formatting + glob helpers.
 *
 * Ported verbatim (case-for-case, same expected values) from
 * packages/hub/test/page-logic.test.ts, which exercised the original plain-JS
 * helpers in packages/hub/public/app.js. The behavior under test is the spec:
 * the typed port in ../src/logic.ts must keep every value identical.
 */

import { describe, it, expect } from "vitest";
import {
  formatRelative,
  formatCountdown,
  colorForName,
  initialsFor,
  distinctRepos,
  boardRepos,
  matchesRepo,
  defaultRepo,
  statusLabel,
  formatActiveDuration,
  dayBucket,
  parseMention,
  extractTarget,
  mentionableAgents,
  globsCover,
  groupActiveClaims,
} from "../src/logic.js";

const NOW_MS = Date.parse("2026-06-24T12:00:00.000Z");
const iso = (offsetSeconds: number): string =>
  new Date(NOW_MS + offsetSeconds * 1000).toISOString();

describe("formatRelative", () => {
  it("shows 'just now' within 5 seconds", () => {
    expect(formatRelative(iso(-2), NOW_MS)).toBe("just now");
  });

  it("shows seconds under a minute", () => {
    expect(formatRelative(iso(-30), NOW_MS)).toBe("30s ago");
  });

  it("shows minutes under an hour", () => {
    expect(formatRelative(iso(-125), NOW_MS)).toBe("2m ago");
  });

  it("shows hours under a day", () => {
    expect(formatRelative(iso(-3 * 3600), NOW_MS)).toBe("3h ago");
  });

  it("shows days beyond 24 hours", () => {
    expect(formatRelative(iso(-50 * 3600), NOW_MS)).toBe("2d ago");
  });
});

describe("formatCountdown", () => {
  it("shows 'expired' at or past the expiry instant", () => {
    expect(formatCountdown(iso(-1), NOW_MS)).toBe("expired");
    expect(formatCountdown(iso(0), NOW_MS)).toBe("expired");
  });

  it("shows seconds remaining under a minute", () => {
    expect(formatCountdown(iso(45), NOW_MS)).toBe("expires in 45s");
  });

  it("shows minutes remaining under an hour", () => {
    expect(formatCountdown(iso(4 * 60 + 10), NOW_MS)).toBe("expires in 4m");
  });

  it("shows hours remaining beyond an hour", () => {
    expect(formatCountdown(iso(2 * 3600 + 5), NOW_MS)).toBe("expires in 2h");
  });
});

describe("colorForName", () => {
  it("returns a deterministic hsl() color for a given name", () => {
    const a = colorForName("RedDragon");
    const b = colorForName("RedDragon");
    expect(a).toBe(b);
    expect(a).toMatch(/^hsl\(/);
  });

  it("gives different names different hues", () => {
    expect(colorForName("RedDragon")).not.toBe(colorForName("BlueWolf"));
  });

  it("does not throw on an empty name", () => {
    expect(() => colorForName("")).not.toThrow();
    expect(colorForName("")).toMatch(/^hsl\(/);
  });
});

describe("initialsFor", () => {
  it("uses the capital letters of a CamelCase agent name", () => {
    expect(initialsFor("RedDragon")).toBe("RD");
    expect(initialsFor("BlueWolf")).toBe("BW");
  });

  it("falls back to the first two letters for a lowercase name", () => {
    expect(initialsFor("alice")).toBe("AL");
  });

  it("returns a placeholder for an empty name", () => {
    expect(initialsFor("")).toBe("?");
  });
});

describe("distinctRepos", () => {
  it("returns sorted unique repos", () => {
    const tasks = [{ repo: "b" }, { repo: "a" }, { repo: "b" }];
    expect(distinctRepos(tasks)).toEqual(["a", "b"]);
  });
});

describe("boardRepos", () => {
  it("unions repos across tasks, agents, and announcements, sorted", () => {
    const board = {
      tasks: [{ repo: "b" }],
      agents: [{ repo: "c" }, { repo: "b" }],
      announcements: [{ repo: "a" }],
    };
    expect(boardRepos(board)).toEqual(["a", "b", "c"]);
  });

  it("surfaces repos with no tasks (agents/chat only) — the selector must not vanish", () => {
    const board = {
      tasks: [{ repo: "only-repo-with-tasks" }],
      agents: [{ repo: "agent-only-repo" }],
      announcements: [],
    };
    expect(boardRepos(board)).toEqual([
      "agent-only-repo",
      "only-repo-with-tasks",
    ]);
  });

  it("skips null/empty repos (an agent with no session yet)", () => {
    const board = {
      tasks: [],
      agents: [{ repo: null }, { repo: "" }, { repo: "x" }],
      announcements: [{ repo: "" }],
    };
    expect(boardRepos(board)).toEqual(["x"]);
  });
});

describe("matchesRepo", () => {
  it("matches all when selected is null or the all-sentinel", () => {
    expect(matchesRepo({ repo: "x" }, null)).toBe(true);
    expect(matchesRepo({ repo: "x" }, "__all__")).toBe(true);
  });
  it("matches only the selected repo otherwise", () => {
    expect(matchesRepo({ repo: "x" }, "x")).toBe(true);
    expect(matchesRepo({ repo: "y" }, "x")).toBe(false);
  });
});

describe("defaultRepo", () => {
  it("prefers the newest active task's repo", () => {
    const tasks = [
      { repo: "b", status: "done" as const },
      { repo: "a", status: "active" as const },
    ];
    expect(defaultRepo(tasks)).toBe("a");
  });
  it("falls back to the first task's repo when none active", () => {
    expect(defaultRepo([{ repo: "b", status: "done" as const }])).toBe("b");
  });
  it("returns null for no tasks", () => {
    expect(defaultRepo([])).toBeNull();
  });
});

describe("mentionableAgents", () => {
  const agents = [
    { name: "RedDragon", presence: "live" as const, repo: "x" },
    { name: "BlueWolf", presence: "live" as const, repo: "y" },
    { name: "GhostFox", presence: "idle" as const, repo: "x" },
    { name: "RedDragon", presence: "live" as const, repo: "x" }, // duplicate name
  ];

  it("returns only live agents in the selected repo, deduped and sorted", () => {
    expect(mentionableAgents(agents, "x")).toEqual(["RedDragon"]);
  });

  it("excludes live agents whose session is in another repo", () => {
    expect(mentionableAgents(agents, "x")).not.toContain("BlueWolf");
  });

  it("includes every live agent across repos in All-repos mode", () => {
    expect(mentionableAgents(agents, "__all__")).toEqual([
      "BlueWolf",
      "RedDragon",
    ]);
    expect(mentionableAgents(agents, null)).toEqual(["BlueWolf", "RedDragon"]);
  });

  it("never includes non-live agents", () => {
    expect(mentionableAgents(agents, "__all__")).not.toContain("GhostFox");
  });
});

describe("statusLabel", () => {
  it("labels history statuses", () => {
    expect(statusLabel("done")).toBe("done");
    expect(statusLabel("dropped")).toBe("dropped");
  });
});

describe("formatActiveDuration", () => {
  it("returns 'active Nm' from created->ended span", () => {
    const created = "2026-06-25T12:00:00.000Z";
    const ended = "2026-06-25T12:22:00.000Z";
    expect(formatActiveDuration(created, ended)).toBe("active 22m");
  });
  it("returns empty string when not ended", () => {
    expect(formatActiveDuration("2026-06-25T12:00:00.000Z", null)).toBe("");
  });
});

describe("dayBucket", () => {
  const now = Date.parse("2026-06-25T12:00:00.000Z");
  it("buckets same day as Today", () => {
    expect(dayBucket("2026-06-25T09:00:00.000Z", now)).toBe("Today");
  });
  it("buckets previous day as Yesterday", () => {
    expect(dayBucket("2026-06-24T09:00:00.000Z", now)).toBe("Yesterday");
  });
});

describe("globsCover", () => {
  it("covers a path nested under a directory wildcard", () => {
    expect(globsCover(["src/**"], ["src/a/b.ts"])).toBe(true);
  });

  it("a directory wildcard covers the bare directory itself", () => {
    expect(globsCover(["src/**"], ["src"])).toBe(true);
  });

  it("does NOT cover a sibling outside the territory", () => {
    expect(globsCover(["src/**"], ["lib/x.ts"])).toBe(false);
  });

  it("a single-segment * does not cover a deep ** (safety)", () => {
    expect(globsCover(["src/*"], ["src/**"])).toBe(false);
  });

  it("a literal does not cover a wildcard segment (safety)", () => {
    expect(globsCover(["src/a.ts"], ["src/*"])).toBe(false);
  });

  it("covers only when EVERY glob in the candidate set is covered", () => {
    expect(globsCover(["a/**", "b/**"], ["a/x", "b/y"])).toBe(true);
    expect(globsCover(["a/**"], ["a/x", "b/y"])).toBe(false);
  });

  it("treats an equal glob set as covering (mutual)", () => {
    expect(globsCover(["a/**"], ["a/**"])).toBe(true);
  });

  it("does not consider partially-overlapping sets as covering", () => {
    expect(globsCover(["a/**", "b/**"], ["b/**", "c/**"])).toBe(false);
  });
});

describe("groupActiveClaims", () => {
  const claim = (
    agentName: string,
    pathGlobs: string[],
    createdAt: string,
    extra: Partial<{
      model: string;
      program: string;
      repo: string;
      status: string;
      intent: string;
    }> = {},
  ) => ({
    agentName,
    pathGlobs,
    createdAt,
    intent: "do work",
    repo: "repo",
    model: "claude-code",
    program: "claude-code",
    status: "active",
    ...extra,
  });

  it("returns one group per agent with a lone claim as its sole primary", () => {
    const groups = groupActiveClaims([claim("a", ["src/**"], iso(0))]);
    expect(groups).toHaveLength(1);
    expect(groups[0].agentName).toBe("a");
    expect(groups[0].primaries).toHaveLength(1);
    expect(groups[0].narrower).toEqual([]);
  });

  it("folds a fully-covered claim under its broader sibling as narrower", () => {
    const broad = claim("a", ["src/**", "make.ps1"], iso(0));
    const narrow = claim("a", ["src/ingest/x.py", "src/tests/**"], iso(-10));
    const groups = groupActiveClaims([broad, narrow]);
    expect(groups).toHaveLength(1);
    expect(groups[0].primaries.map((c) => c.pathGlobs)).toEqual([
      broad.pathGlobs,
    ]);
    expect(groups[0].narrower.map((c) => c.pathGlobs)).toEqual([
      narrow.pathGlobs,
    ]);
  });

  it("keeps two non-overlapping claims both as visible primaries", () => {
    const c1 = claim("a", ["src/venues/**"], iso(0));
    const c2 = claim("a", ["lib/poly/**"], iso(-5));
    const groups = groupActiveClaims([c1, c2]);
    expect(groups[0].primaries).toHaveLength(2);
    expect(groups[0].narrower).toEqual([]);
  });

  it("does NOT fold claims that merely overlap without containment", () => {
    const c1 = claim("a", ["src/a/**", "src/b/**"], iso(0));
    const c2 = claim("a", ["src/b/**", "src/c/**"], iso(-5));
    const groups = groupActiveClaims([c1, c2]);
    expect(groups[0].primaries).toHaveLength(2);
    expect(groups[0].narrower).toEqual([]);
  });

  it("separates different agents into different groups, newest first", () => {
    const groups = groupActiveClaims([
      claim("old", ["x/**"], iso(-100)),
      claim("new", ["y/**"], iso(0)),
    ]);
    expect(groups.map((g) => g.agentName)).toEqual(["new", "old"]);
  });

  it("carries representative header fields from the group's newest claim", () => {
    const groups = groupActiveClaims([
      claim("a", ["x/**"], iso(0), { model: "opus", repo: "R" }),
    ]);
    expect(groups[0].model).toBe("opus");
    expect(groups[0].repo).toBe("R");
  });
});

describe("parseMention", () => {
  it("detects a bare @ right after whitespace", () => {
    const text = "hi @";
    expect(parseMention(text, 4)).toEqual({ start: 3, end: 4, query: "" });
  });

  it("captures the token typed after @ (anywhere in the message)", () => {
    const text = "ping @Red about this";
    // caret right after "@Red" (index 9)
    expect(parseMention(text, 9)).toEqual({ start: 5, end: 9, query: "Red" });
  });

  it("matches @ at the very start of the message", () => {
    expect(parseMention("@da", 3)).toEqual({ start: 0, end: 3, query: "da" });
  });

  it("allows hyphenated ordinal names like alex-6", () => {
    expect(parseMention("yo @alex-6", 10)).toEqual({
      start: 3,
      end: 10,
      query: "alex-6",
    });
  });

  it("does NOT trigger on an @ that follows a non-space (e.g. an email)", () => {
    expect(parseMention("mail a@b", 8)).toBeNull();
  });

  it("returns null when the caret is not inside a mention token", () => {
    expect(parseMention("@Red hello", 10)).toBeNull(); // caret after a space + word
    expect(parseMention("no mention", 10)).toBeNull();
  });
});

describe("extractTarget", () => {
  const known = ["RedDragon", "BlueWolf", "alex-6"];

  it("returns the canonical name for a matching @mention", () => {
    expect(extractTarget("@RedDragon take a look", known)).toBe("RedDragon");
  });

  it("matches case-insensitively but returns canonical casing", () => {
    expect(extractTarget("hey @reddragon", known)).toBe("RedDragon");
  });

  it("resolves a hyphenated ordinal name mid-message", () => {
    expect(extractTarget("can @alex-6 confirm?", known)).toBe("alex-6");
  });

  it("returns the FIRST matching mention when several are present", () => {
    expect(extractTarget("@BlueWolf and @RedDragon", known)).toBe("BlueWolf");
  });

  it("returns null when no @mention matches a known agent", () => {
    expect(extractTarget("@nobody hello", known)).toBeNull();
    expect(extractTarget("just a broadcast", known)).toBeNull();
  });

  it("does not treat an email address as a mention", () => {
    expect(extractTarget("write me at red@dragon.com", ["dragon"])).toBeNull();
  });
});
