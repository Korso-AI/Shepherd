import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeMailboxMeta,
  sessionMailboxPath,
} from "../src/inbox.js";
import {
  resolveHookMailboxes,
  pairingCachePath,
} from "../src/hookPairing.js";

// Chains: the hook under bash under client 700; the server under client 700
// via an npx hop. quickChain (two hops) stops at bash (800) — only the FULL
// chain reaches the shared client.
const QUICK = [900, 800];
const FULL = [900, 800, 700, 600];
const CWD = "/repos/projectA";
const SESSION = "sess-abc-123";

describe("resolveHookMailboxes", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shepherd-pairing-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns a quick-chain match without ever taking a snapshot", async () => {
    // Direct-spawn clients (Codex, Cursor, Pi) and POSIX bash-exec put the
    // client pid right in the hook's ppid.
    writeMailboxMeta(dir, 111, { cwd: CWD, chain: [111, 800] });
    const full = vi.fn();
    const boxes = await resolveHookMailboxes(
      dir,
      { sessionId: SESSION, cwd: CWD },
      { quick: () => QUICK, full },
    );
    expect(boxes).toEqual([sessionMailboxPath(dir, 111)]);
    expect(full).not.toHaveBeenCalled();
  });

  it("skips the snapshot entirely when nothing is advertised", async () => {
    const full = vi.fn();
    const boxes = await resolveHookMailboxes(
      dir,
      { sessionId: SESSION, cwd: CWD },
      { quick: () => QUICK, full },
    );
    expect(boxes).toEqual([]);
    expect(full).not.toHaveBeenCalled();
  });

  it("escalates to the full chain and caches it under the session id", async () => {
    writeMailboxMeta(dir, 111, { cwd: CWD, chain: [111, 50, 700] });
    const full = vi.fn(async () => FULL);
    const boxes = await resolveHookMailboxes(
      dir,
      { sessionId: SESSION, cwd: CWD },
      { quick: () => QUICK, full },
    );
    expect(boxes).toEqual([sessionMailboxPath(dir, 111)]);
    expect(full).toHaveBeenCalledTimes(1);
    expect(existsSync(pairingCachePath(dir, SESSION))).toBe(true);
  });

  it("reuses the cached chain on later fires (no second snapshot)", async () => {
    writeMailboxMeta(dir, 111, { cwd: CWD, chain: [111, 50, 700] });
    await resolveHookMailboxes(
      dir,
      { sessionId: SESSION, cwd: CWD },
      { quick: () => QUICK, full: async () => FULL },
    );

    const fullAgain = vi.fn();
    const boxes = await resolveHookMailboxes(
      dir,
      { sessionId: SESSION, cwd: CWD },
      { quick: () => QUICK, full: fullAgain },
    );
    expect(boxes).toEqual([sessionMailboxPath(dir, 111)]);
    expect(fullAgain).not.toHaveBeenCalled();
  });

  it("works without a session id (snapshot each time, nothing cached)", async () => {
    writeMailboxMeta(dir, 111, { cwd: CWD, chain: [111, 700] });
    const boxes = await resolveHookMailboxes(
      dir,
      { cwd: CWD },
      { quick: () => QUICK, full: async () => FULL },
    );
    expect(boxes).toEqual([sessionMailboxPath(dir, 111)]);
    expect(readdirSync(dir).filter((n) => n.startsWith("pairing-"))).toEqual(
      [],
    );
  });

  it("a stale cached chain self-heals through a fresh snapshot", async () => {
    // Session resumed in a NEW client process: the cache still holds the dead
    // client's pids, the fresh meta only the new ones.
    writeMailboxMeta(dir, 111, { cwd: CWD, chain: [111, 50, 700] });
    await resolveHookMailboxes(
      dir,
      { sessionId: SESSION, cwd: CWD },
      { quick: () => [1, 2], full: async () => [1, 2, 3] }, // matches nothing, cached
    );
    const boxes = await resolveHookMailboxes(
      dir,
      { sessionId: SESSION, cwd: CWD },
      { quick: () => QUICK, full: async () => FULL },
    );
    expect(boxes).toEqual([sessionMailboxPath(dir, 111)]);
  });

  it("fails open to [] when the snapshot itself fails", async () => {
    writeMailboxMeta(dir, 111, { cwd: CWD, chain: [111, 700] });
    const boxes = await resolveHookMailboxes(
      dir,
      { sessionId: SESSION, cwd: CWD },
      {
        quick: () => QUICK,
        full: async () => {
          throw new Error("no snapshot tool");
        },
      },
    );
    expect(boxes).toEqual([]);
  });
});
