/**
 * Tests for packages/hub/src/clientVersion.ts — the hub advertises the client
 * version bundled alongside it in the monorepo (baked into the image at build
 * time). Reading it must fail open: a hub that cannot find the file simply
 * advertises nothing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readLatestClientVersion,
  advertisedClientVersion,
} from "../src/clientVersion.js";

describe("readLatestClientVersion", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shepherd-clientver-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the version field from a package.json", () => {
    const file = join(dir, "package.json");
    writeFileSync(file, JSON.stringify({ name: "x", version: "1.2.3" }));
    expect(readLatestClientVersion(file)).toBe("1.2.3");
  });

  it("returns null when the file is missing", () => {
    expect(readLatestClientVersion(join(dir, "nope.json"))).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    const file = join(dir, "package.json");
    writeFileSync(file, "{ nope");
    expect(readLatestClientVersion(file)).toBeNull();
  });

  it("returns null when version is absent or not a string", () => {
    const file = join(dir, "package.json");
    writeFileSync(file, JSON.stringify({ name: "x", version: 7 }));
    expect(readLatestClientVersion(file)).toBeNull();
  });
});

describe("advertisedClientVersion", () => {
  it("resolves the monorepo mcp-server package.json from the hub source tree", () => {
    // Guards the ../../mcp-server relative hop — the same layout the Docker
    // image reproduces under /app/packages/.
    const version = advertisedClientVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
