import { describe, it, expect } from "vitest";
import {
  pidChainFromMap,
  parseWmicProcessList,
  parsePidPpidLines,
  quickChain,
  ancestorChain,
} from "../src/processTree.js";

describe("pidChainFromMap", () => {
  it("walks self → parent → grandparent in order", () => {
    const map = new Map([
      [100, 50],
      [50, 10],
      [10, 1],
    ]);
    expect(pidChainFromMap(100, map)).toEqual([100, 50, 10, 1]);
  });

  it("stops at a pid with no snapshot entry", () => {
    const map = new Map([[100, 50]]);
    expect(pidChainFromMap(100, map)).toEqual([100, 50]);
  });

  it("stops on a parent of 0 (Windows System Idle) without including it", () => {
    const map = new Map([
      [100, 4],
      [4, 0],
    ]);
    expect(pidChainFromMap(100, map)).toEqual([100, 4]);
  });

  it("guards against cycles from pid reuse in a stale snapshot", () => {
    const map = new Map([
      [100, 50],
      [50, 100],
    ]);
    expect(pidChainFromMap(100, map)).toEqual([100, 50]);
  });

  it("caps the walk at maxDepth entries", () => {
    const map = new Map<number, number>();
    for (let i = 1; i < 100; i++) map.set(i, i + 1);
    expect(pidChainFromMap(1, map, 5)).toHaveLength(5);
  });
});

describe("snapshot parsers", () => {
  it("parses wmic output regardless of column order", () => {
    // wmic sorts requested columns alphabetically: ParentProcessId first.
    const wmic = [
      "ParentProcessId  ProcessId  ",
      "0                4          ",
      "788              1234       ",
      "1234             5678       ",
      "",
    ].join("\r\n");
    const map = parseWmicProcessList(wmic);
    expect(map.get(5678)).toBe(1234);
    expect(map.get(1234)).toBe(788);
  });

  it("parses wmic output with ProcessId first too", () => {
    const wmic = [
      "ProcessId  ParentProcessId  ",
      "4          0                ",
      "5678       1234             ",
    ].join("\r\n");
    expect(parseWmicProcessList(wmic).get(5678)).toBe(1234);
  });

  it("returns an empty map for garbage wmic output", () => {
    expect(parseWmicProcessList("ERROR: not recognized").size).toBe(0);
  });

  it("parses pid/ppid line pairs (PowerShell and POSIX ps forms)", () => {
    const text = "  1234 788\n 5678   1234 \n\nnot a line\n";
    const map = parsePidPpidLines(text);
    expect(map.get(1234)).toBe(788);
    expect(map.get(5678)).toBe(1234);
    expect(map.size).toBe(2);
  });
});

describe("live process tree (smoke)", () => {
  it("quickChain is [own pid, parent pid]", () => {
    expect(quickChain()).toEqual([process.pid, process.ppid]);
  });

  it("ancestorChain starts with own pid and reaches past the parent", async () => {
    const chain = await ancestorChain();
    expect(chain[0]).toBe(process.pid);
    expect(chain[1]).toBe(process.ppid);
    // Every entry unique, all positive ints.
    expect(new Set(chain).size).toBe(chain.length);
    for (const pid of chain) {
      expect(Number.isInteger(pid)).toBe(true);
      expect(pid).toBeGreaterThan(0);
    }
    // A vitest worker always has at least a grandparent (vitest → node → shell/OS).
    expect(chain.length).toBeGreaterThanOrEqual(3);
  }, 20_000);

  it("ancestorChain fails open to the quick chain when the snapshot errors", async () => {
    const chain = await ancestorChain(32, async () => {
      throw new Error("no snapshot tool");
    });
    expect(chain).toEqual([process.pid, process.ppid]);
  });
});
