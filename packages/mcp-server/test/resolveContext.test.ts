import { describe, it, expect } from "vitest";
import { adjectives, nouns } from "@shepherd/shared";
import { resolveContext, type JoinContext } from "../src/resolveContext.js";
import type { Config } from "../src/config.js";

/** Minimal valid Config with all optional overrides absent. */
function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    HUB_URL: "http://hub.test",
    TEAM_TOKEN: "tok",
    HEARTBEAT_INTERVAL_SECONDS: 60,
    SHEPHERD_NO_AUTO_HOOKS: false,
    ...overrides,
  };
}

/**
 * In-memory device-identity cache fake. Tracks reads/writes so tests can assert
 * the cache is (or is not) touched without going near the real disk.
 */
function memoryCache(initial: string | null = null) {
  let value = initial;
  const writes: string[] = [];
  return {
    readCachedHuman: () => value,
    writeCachedHuman: (human: string) => {
      writes.push(human);
      value = human;
    },
    get value() {
      return value;
    },
    get writes() {
      return writes;
    },
  };
}

/** No-op cache deps for tests that don't care about caching. */
const noCacheDeps = {
  readCachedHuman: () => null,
  writeCachedHuman: () => {},
};

/** All detection deps stubbed to return non-null detected values. */
const detectingDeps = {
  detectRepo: () => "detected-repo",
  detectBranch: () => "detected-branch",
  detectHuman: () => "DetectedHuman",
  readMarker: () => null,
  findRepoRoot: () => null,
  isDeclined: () => false,
  ...noCacheDeps,
};

/** All detection deps stubbed to fail open (null). */
const nullDeps = {
  detectRepo: () => null,
  detectBranch: () => null,
  detectHuman: () => null,
  readMarker: () => null,
  findRepoRoot: () => null,
  isDeclined: () => false,
  ...noCacheDeps,
};

const KNOWN_NAMES = new Set(adjectives.flatMap((a) => nouns.map((n) => a + n)));

describe("resolveContext", () => {
  it("env overrides win over detection", async () => {
    const config = baseConfig({
      WORKSPACE: "ws-override",
      REPO: "override-repo",
      BRANCH: "override-branch",
      HUMAN: "OverrideHuman",
      PROGRAM: "custom-program",
      MODEL: "custom-model",
    });

    const ctx: JoinContext = await resolveContext(
      config,
      "/some/cwd",
      detectingDeps,
    );

    expect(ctx).toEqual({
      workspace: "ws-override",
      repo: "override-repo",
      branch: "override-branch",
      human: "OverrideHuman",
      program: "custom-program",
      model: "custom-model",
      linked: false,
      declined: false,
      linkState: "unanswered",
    });
  });

  it("uses detected values when config fields are unset", async () => {
    const config = baseConfig();

    const ctx = await resolveContext(config, "/some/cwd", detectingDeps);

    expect(ctx.repo).toBe("detected-repo");
    expect(ctx.branch).toBe("detected-branch");
    expect(ctx.human).toBe("DetectedHuman");
    // Not detected — defaults apply.
    expect(ctx.program).toBe("claude-code");
    expect(ctx.model).toBeUndefined();
    expect(ctx.workspace).toBe("default");
  });

  it("falls back when config unset and detection returns null", async () => {
    const config = baseConfig();

    const ctx = await resolveContext(config, "/some/cwd", nullDeps);

    expect(ctx.repo).toBe("unknown-repo");
    expect(ctx.branch).toBe("HEAD");
    expect(ctx.program).toBe("claude-code");
    expect(ctx.model).toBeUndefined();
    expect(ctx.workspace).toBe("default");

    // human falls back to a generated name: non-empty and from the name set.
    expect(typeof ctx.human).toBe("string");
    expect(ctx.human.length).toBeGreaterThan(0);
    expect(KNOWN_NAMES.has(ctx.human)).toBe(true);
  });

  it("canonicalizes the repo from any source (URL/scp/case/owner) to the bare repo name", async () => {
    // Explicit REPO override in remote-URL form is reduced to the bare name + lowercased.
    const fromScp = await resolveContext(
      baseConfig({ REPO: "git@github.com:Org/App.git" }),
      "/cwd",
      nullDeps,
    );
    expect(fromScp.repo).toBe("app");

    const fromHttps = await resolveContext(
      baseConfig({ REPO: "https://github.com/Org/App" }),
      "/cwd",
      nullDeps,
    );
    expect(fromHttps.repo).toBe("app");

    // An owner/repo detected value (origin clone) is reduced to the bare name...
    const fromOwnerRepo = await resolveContext(baseConfig(), "/cwd", {
      ...nullDeps,
      detectRepo: () => "Org/App",
    });
    expect(fromOwnerRepo.repo).toBe("app");

    // ...so it converges with a bare basename (no-origin fallback) for the same repo.
    const fromBasename = await resolveContext(baseConfig(), "/cwd", {
      ...nullDeps,
      detectRepo: () => "App",
    });
    expect(fromBasename.repo).toBe("app");
  });

  it("passes the given cwd to detection functions", async () => {
    const seen: string[] = [];
    const config = baseConfig();
    await resolveContext(config, "/explicit/cwd", {
      detectRepo: (cwd) => {
        seen.push(cwd);
        return "r";
      },
      detectBranch: (cwd) => {
        seen.push(cwd);
        return "b";
      },
      detectHuman: (cwd) => {
        seen.push(cwd);
        return "h";
      },
      readMarker: (cwd) => {
        seen.push(cwd);
        return null;
      },
      findRepoRoot: () => null,
      isDeclined: () => false,
      ...noCacheDeps,
    });
    expect(seen.every((c) => c === "/explicit/cwd")).toBe(true);
  });

  describe("repo opt-in marker", () => {
    it("is not linked and uses the workspace default when no marker is present", async () => {
      const ctx = await resolveContext(baseConfig(), "/cwd", {
        ...detectingDeps,
        readMarker: () => null,
      });
      expect(ctx.linked).toBe(false);
      expect(ctx.workspace).toBe("default");
    });

    it("is linked and takes its workspace from the marker (overriding the cwd-basename default)", async () => {
      const ctx = await resolveContext(baseConfig(), "/cwd", {
        ...detectingDeps,
        readMarker: () => ({ workspace: "acme" }),
      });
      expect(ctx.linked).toBe(true);
      expect(ctx.workspace).toBe("acme");
    });

    it("the marker workspace wins even over a WORKSPACE env override", async () => {
      const ctx = await resolveContext(
        baseConfig({ WORKSPACE: "env-ws" }),
        "/cwd",
        { ...detectingDeps, readMarker: () => ({ workspace: "marker-ws" }) },
      );
      expect(ctx.linked).toBe(true);
      expect(ctx.workspace).toBe("marker-ws");
    });

    it("passes the cwd to readMarker", async () => {
      const seen: string[] = [];
      await resolveContext(baseConfig(), "/explicit/cwd", {
        ...detectingDeps,
        readMarker: (cwd) => {
          seen.push(cwd);
          return null;
        },
      });
      expect(seen).toContain("/explicit/cwd");
    });
  });

  describe("first-run declined state", () => {
    it("no marker + not declined → unanswered, declined false", async () => {
      const ctx = await resolveContext(baseConfig(), "/cwd", {
        ...detectingDeps,
        readMarker: () => null,
        findRepoRoot: () => "/repo/root",
        isDeclined: () => false,
      });
      expect(ctx.linked).toBe(false);
      expect(ctx.declined).toBe(false);
      expect(ctx.linkState).toBe("unanswered");
    });

    it("no marker + declined → declined state, keyed by the repo root", async () => {
      const seen: string[] = [];
      const ctx = await resolveContext(baseConfig(), "/cwd", {
        ...detectingDeps,
        readMarker: () => null,
        findRepoRoot: () => "/repo/root",
        isDeclined: (root) => {
          seen.push(root);
          return true;
        },
      });
      expect(ctx.linked).toBe(false);
      expect(ctx.declined).toBe(true);
      expect(ctx.linkState).toBe("declined");
      // Declined is keyed off the resolved repo root, not the raw cwd.
      expect(seen).toEqual(["/repo/root"]);
    });

    it("marker present wins over a stale decline → linkState linked", async () => {
      const ctx = await resolveContext(baseConfig(), "/cwd", {
        ...detectingDeps,
        readMarker: () => ({ workspace: "acme" }),
        findRepoRoot: () => "/repo/root",
        isDeclined: () => true,
      });
      expect(ctx.linked).toBe(true);
      // Reported honestly as the raw on-disk state, but resolved to `linked`.
      expect(ctx.declined).toBe(true);
      expect(ctx.linkState).toBe("linked");
    });

    it("not in a repo (no repo root) → fail-open undeclined/unanswered, isDeclined not called", async () => {
      let called = false;
      const ctx = await resolveContext(baseConfig(), "/cwd", {
        ...detectingDeps,
        readMarker: () => null,
        findRepoRoot: () => null,
        isDeclined: () => {
          called = true;
          return true;
        },
      });
      expect(ctx.declined).toBe(false);
      expect(ctx.linkState).toBe("unanswered");
      expect(called).toBe(false);
    });
  });

  describe("human device-identity cache", () => {
    it("HUMAN env override wins and never writes the cache", async () => {
      const cache = memoryCache(null);
      const ctx = await resolveContext(
        baseConfig({ HUMAN: "OverrideHuman" }),
        "/cwd",
        {
          ...detectingDeps,
          ...cache,
        },
      );
      expect(ctx.human).toBe("OverrideHuman");
      expect(cache.writes).toEqual([]);
    });

    it("git-detected human wins and refreshes a stale cache", async () => {
      const cache = memoryCache("OldName");
      const ctx = await resolveContext(baseConfig(), "/cwd", {
        ...detectingDeps,
        ...cache,
      });
      expect(ctx.human).toBe("DetectedHuman");
      expect(cache.writes).toContain("DetectedHuman");
      expect(cache.value).toBe("DetectedHuman");
    });

    it("uses the device cache when git cannot detect a human", async () => {
      const cache = memoryCache("maeriyn");
      const ctx = await resolveContext(baseConfig(), "/cwd", {
        ...nullDeps,
        ...cache,
      });
      expect(ctx.human).toBe("maeriyn");
      // No git identity to persist, so no write occurs.
      expect(cache.writes).toEqual([]);
    });

    it("generates a random name only when git fails AND the cache is empty", async () => {
      const cache = memoryCache(null);
      const ctx = await resolveContext(baseConfig(), "/cwd", {
        ...nullDeps,
        ...cache,
      });
      expect(KNOWN_NAMES.has(ctx.human)).toBe(true);
      expect(cache.writes).toEqual([]);
    });
  });
});
