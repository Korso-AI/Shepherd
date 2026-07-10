import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareVersions, maybeUpdateNudge } from "../src/updateNudge.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("compareVersions", () => {
  it("returns 0 for equal versions", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("orders patch, minor, and major differences", () => {
    expect(compareVersions("1.2.3", "1.2.4")).toBeLessThan(0);
    expect(compareVersions("1.3.0", "1.2.9")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
  });

  it("compares segments numerically, not lexicographically", () => {
    expect(compareVersions("0.9.1", "0.10.0")).toBeLessThan(0);
  });

  it("treats missing segments as zero", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.1")).toBeLessThan(0);
  });
});

describe("maybeUpdateNudge", () => {
  let dir: string;
  let stampFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shepherd-nudge-"));
    stampFile = join(dir, "update-nudge.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty when the hub advertised no latest version", () => {
    const nudge = maybeUpdateNudge({
      current: "0.10.0",
      stampFile,
      nowMs: 1_000,
    });
    expect(nudge).toBe("");
    expect(existsSync(stampFile)).toBe(false);
  });

  it("returns empty when already up to date or ahead", () => {
    expect(
      maybeUpdateNudge({
        current: "0.10.0",
        latest: "0.10.0",
        stampFile,
        nowMs: 1_000,
      }),
    ).toBe("");
    expect(
      maybeUpdateNudge({
        current: "0.11.0",
        latest: "0.10.0",
        stampFile,
        nowMs: 1_000,
      }),
    ).toBe("");
    expect(existsSync(stampFile)).toBe(false);
  });

  it("nudges when behind, naming both versions and telling the agent to inform their human", () => {
    const nudge = maybeUpdateNudge({
      current: "0.10.0",
      latest: "0.11.0",
      stampFile,
      nowMs: 1_000,
    });
    expect(nudge).toContain("0.10.0");
    expect(nudge).toContain("0.11.0");
    expect(nudge.toLowerCase()).toContain("human");
    expect(nudge.toLowerCase()).toContain("installed");
  });

  it("stays quiet within the 24h cooldown for the same latest version", () => {
    maybeUpdateNudge({
      current: "0.10.0",
      latest: "0.11.0",
      stampFile,
      nowMs: 1_000,
    });
    const again = maybeUpdateNudge({
      current: "0.10.0",
      latest: "0.11.0",
      stampFile,
      nowMs: 1_000 + DAY_MS - 60_000,
    });
    expect(again).toBe("");
  });

  it("nudges again once the cooldown has elapsed", () => {
    maybeUpdateNudge({
      current: "0.10.0",
      latest: "0.11.0",
      stampFile,
      nowMs: 1_000,
    });
    const again = maybeUpdateNudge({
      current: "0.10.0",
      latest: "0.11.0",
      stampFile,
      nowMs: 1_000 + DAY_MS + 60_000,
    });
    expect(again).not.toBe("");
  });

  it("nudges immediately when a newer version than the stamped one appears", () => {
    maybeUpdateNudge({
      current: "0.10.0",
      latest: "0.11.0",
      stampFile,
      nowMs: 1_000,
    });
    const newer = maybeUpdateNudge({
      current: "0.10.0",
      latest: "0.12.0",
      stampFile,
      nowMs: 2_000,
    });
    expect(newer).toContain("0.12.0");
  });

  it("bypasses the cooldown when below the minimum supported version", () => {
    maybeUpdateNudge({
      current: "0.9.0",
      latest: "0.11.0",
      minimum: "0.10.0",
      stampFile,
      nowMs: 1_000,
    });
    const again = maybeUpdateNudge({
      current: "0.9.0",
      latest: "0.11.0",
      minimum: "0.10.0",
      stampFile,
      nowMs: 2_000,
    });
    expect(again).not.toBe("");
    expect(again.toLowerCase()).toContain("minimum");
  });

  it("does not use the urgent wording when at or above the minimum", () => {
    const nudge = maybeUpdateNudge({
      current: "0.10.0",
      latest: "0.11.0",
      minimum: "0.10.0",
      stampFile,
      nowMs: 1_000,
    });
    expect(nudge).not.toBe("");
    expect(nudge.toLowerCase()).not.toContain("minimum");
  });

  it("returns empty for an unparseable latest version", () => {
    const nudge = maybeUpdateNudge({
      current: "0.10.0",
      latest: "not-a-version",
      stampFile,
      nowMs: 1_000,
    });
    expect(nudge).toBe("");
  });

  it("nudges despite a corrupt stamp file", () => {
    writeFileSync(stampFile, "{ nope", "utf8");
    const nudge = maybeUpdateNudge({
      current: "0.10.0",
      latest: "0.11.0",
      stampFile,
      nowMs: 1_000,
    });
    expect(nudge).not.toBe("");
  });

  it("nudges even when the stamp file cannot be written", () => {
    const nudge = maybeUpdateNudge({
      current: "0.10.0",
      latest: "0.11.0",
      stampFile: join(dir, "no-such-dir", "deep", "stamp.json"),
      nowMs: 1_000,
    });
    expect(nudge).not.toBe("");
  });
});
