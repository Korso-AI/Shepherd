/**
 * Ancestor pid chains — the rendezvous key between an MCP server and the
 * client hook that drains its mailbox (see inbox.ts).
 *
 * Both processes descend from the same client process (Claude Code, Codex,
 * Cursor, Pi): the server as a direct/indirect child (possibly via an npx
 * shim), the hook as a child (direct spawn) or grandchild (Claude Code runs
 * hook commands through a POSIX shell; on Windows msys bash does not exec, so
 * the hook's parent is bash and the client is one hop further). Each side
 * computes its own [self, parent, grandparent, ...] chain; the deepest pid the
 * two chains share is the client process — unique per agent session even when
 * two agents run in the same working directory.
 *
 * Chain discovery is FAIL-OPEN: any snapshot error degrades to the free
 * [self, parent] chain, which is sufficient everywhere except Windows Claude
 * Code (where the caller escalates or gives up and the tool-call delivery path
 * covers the session).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Walk `startPid` up through a pid→ppid snapshot. Returns [startPid, parent,
 * ...], stopping at a missing entry, a non-positive parent (Windows System
 * Idle is ppid 0), a cycle (pid reuse can make a stale snapshot loop), or
 * `maxDepth` entries.
 */
export function pidChainFromMap(
  startPid: number,
  parentOf: Map<number, number>,
  maxDepth = 32,
): number[] {
  const chain: number[] = [];
  const seen = new Set<number>();
  let pid = startPid;
  while (chain.length < maxDepth && pid > 0 && !seen.has(pid)) {
    chain.push(pid);
    seen.add(pid);
    const parent = parentOf.get(pid);
    if (parent === undefined) break;
    pid = parent;
  }
  return chain;
}

/** The free two-entry chain: [own pid, parent pid]. */
export function quickChain(): number[] {
  return [process.pid, process.ppid];
}

/**
 * Parse `wmic process get ProcessId,ParentProcessId` output. wmic orders the
 * requested columns alphabetically, so the header row decides which column is
 * which. Unparseable input yields an empty map (fail-open).
 */
export function parseWmicProcessList(text: string): Map<number, number> {
  const map = new Map<number, number>();
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return map;
  const header = lines[0]!.trimStart();
  // "ProcessId" is a substring of "ParentProcessId", so test the longer first.
  let pidFirst: boolean;
  if (header.startsWith("ParentProcessId")) pidFirst = false;
  else if (header.startsWith("ProcessId")) pidFirst = true;
  else return map;
  for (const line of lines.slice(1)) {
    const nums = line.trim().split(/\s+/).map(Number);
    if (nums.length !== 2 || nums.some((n) => !Number.isInteger(n))) continue;
    const [a, b] = nums as [number, number];
    const [pid, ppid] = pidFirst ? [a, b] : [b, a];
    map.set(pid, ppid);
  }
  return map;
}

/**
 * Parse "pid ppid" line pairs — the shape both the PowerShell fallback and
 * POSIX `ps -eo pid=,ppid=` emit. Non-conforming lines are skipped.
 */
export function parsePidPpidLines(text: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) map.set(Number(m[1]), Number(m[2]));
  }
  return map;
}

/** One full pid→ppid snapshot of the machine, by whatever tool is available. */
export async function snapshotParentMap(): Promise<Map<number, number>> {
  if (process.platform === "win32") {
    // wmic is the fast path (~700ms) but is removed from newer Windows 11
    // builds; PowerShell CIM (~1s) is always present.
    try {
      const { stdout } = await execFileAsync(
        "wmic",
        ["process", "get", "ProcessId,ParentProcessId"],
        { windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
      );
      const map = parseWmicProcessList(stdout);
      if (map.size > 0) return map;
    } catch {
      /* fall through to PowerShell */
    }
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        'Get-CimInstance -Query "SELECT ProcessId,ParentProcessId FROM Win32_Process" | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
      ],
      { windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
    );
    return parsePidPpidLines(stdout);
  }
  const { stdout } = await execFileAsync(
    "ps",
    ["-eo", "pid=,ppid="],
    { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
  );
  return parsePidPpidLines(stdout);
}

/**
 * This process's full ancestor chain, [self, parent, grandparent, ...].
 * Fail-open: if the snapshot fails (or omits us), degrade to quickChain().
 * `snapshot` is a seam for tests.
 */
export async function ancestorChain(
  maxDepth = 32,
  snapshot: () => Promise<Map<number, number>> = snapshotParentMap,
): Promise<number[]> {
  try {
    const map = await snapshot();
    const chain = pidChainFromMap(process.pid, map, maxDepth);
    return chain.length >= 2 ? chain : quickChain();
  } catch {
    return quickChain();
  }
}
