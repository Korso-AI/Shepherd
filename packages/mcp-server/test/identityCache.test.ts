import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCachedHuman, writeCachedHuman } from "../src/identityCache.js";

let dir: string;
let cacheFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shep-identity-"));
  cacheFile = join(dir, "identity.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readCachedHuman", () => {
  it("returns the stored human for a valid cache file", () => {
    writeFileSync(cacheFile, JSON.stringify({ human: "maeriyn" }), "utf8");
    expect(readCachedHuman(cacheFile)).toBe("maeriyn");
  });

  it("returns null when the cache file is absent", () => {
    expect(readCachedHuman(join(dir, "does-not-exist.json"))).toBeNull();
  });

  it("returns null for corrupt JSON", () => {
    writeFileSync(cacheFile, "{ this is not json", "utf8");
    expect(readCachedHuman(cacheFile)).toBeNull();
  });

  it("returns null for a blank/whitespace-only human value", () => {
    writeFileSync(cacheFile, JSON.stringify({ human: "   " }), "utf8");
    expect(readCachedHuman(cacheFile)).toBeNull();
  });

  it("returns null when the human field is missing", () => {
    writeFileSync(cacheFile, JSON.stringify({ other: "x" }), "utf8");
    expect(readCachedHuman(cacheFile)).toBeNull();
  });

  it("trims surrounding whitespace from the stored value", () => {
    writeFileSync(cacheFile, JSON.stringify({ human: "  alex  " }), "utf8");
    expect(readCachedHuman(cacheFile)).toBe("alex");
  });
});

describe("writeCachedHuman", () => {
  it("persists a human name that readCachedHuman can read back", () => {
    writeCachedHuman("maeriyn", cacheFile);
    expect(readCachedHuman(cacheFile)).toBe("maeriyn");
  });

  it("creates the parent directory if it does not exist", () => {
    const nested = join(dir, "nested", "deep", "identity.json");
    writeCachedHuman("alex", nested);
    expect(readCachedHuman(nested)).toBe("alex");
  });

  it("ignores a blank/whitespace-only value and does not clobber a good cache", () => {
    writeCachedHuman("maeriyn", cacheFile);
    writeCachedHuman("   ", cacheFile);
    expect(readCachedHuman(cacheFile)).toBe("maeriyn");
  });

  it("overwrites a previous value with a new one", () => {
    writeCachedHuman("old", cacheFile);
    writeCachedHuman("new", cacheFile);
    expect(readCachedHuman(cacheFile)).toBe("new");
    // No stray content left behind.
    const parsed = JSON.parse(readFileSync(cacheFile, "utf8"));
    expect(parsed).toEqual({ human: "new" });
  });

  it("swallows write failures (fail-open) when the path is unwritable", () => {
    // Point the cache file AT a directory: writeFileSync to a dir path throws,
    // and the fail-open contract requires no throw to escape.
    const dirAsFile = join(dir, "isdir");
    mkdirSync(dirAsFile);
    expect(() => writeCachedHuman("alex", dirAsFile)).not.toThrow();
  });
});
