/**
 * Hook-side mailbox pairing: resolve which session mailboxes (see inbox.ts)
 * this hook invocation may drain, spending as little as possible on process
 * ancestry:
 *
 *  1. The free two-hop chain [self, parent]. Sufficient wherever the client
 *     spawns the hook directly (Codex, Cursor, Pi) or through an exec-ing
 *     POSIX shell (Claude Code on macOS/Linux).
 *  2. A chain cached by an earlier fire of this same session.
 *  3. A full process-tree snapshot (~1s on Windows, where Claude Code runs
 *     hooks through a non-exec-ing msys bash and the client sits one hop past
 *     the parent) — then cached under the session id so each session pays at
 *     most once.
 *
 * When nothing is advertised at all (no live new-format server on this
 * machine), it returns [] before ever taking a snapshot. FAIL-OPEN: every
 * error path yields [], and the announcements reach the session via its own
 * tool calls instead.
 */

import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import {
  selectSessionMailboxes,
  hasFreshSessionMeta,
  MAILBOX_TTL_MS,
} from "./inbox.js";
import { quickChain, ancestorChain } from "./processTree.js";

/** Where a session's resolved ancestor chain is cached between hook fires. */
export function pairingCachePath(dir: string, sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  return join(dir, `pairing-${key}.json`);
}

function readCachedChain(file: string, nowMs: number): number[] | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      chain?: unknown;
      ts?: unknown;
    };
    if (!Array.isArray(parsed.chain) || typeof parsed.ts !== "number")
      return null;
    if (nowMs - parsed.ts > MAILBOX_TTL_MS) return null;
    return parsed.chain as number[];
  } catch {
    return null;
  }
}

function writeCachedChain(
  dir: string,
  file: string,
  chain: number[],
  nowMs: number,
): void {
  try {
    // Sweep expired sibling caches while we're here — this path only runs on
    // the rare snapshot escalation, so the readdir is essentially free.
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("pairing-") || !name.endsWith(".json")) continue;
      try {
        if (nowMs - statSync(join(dir, name)).mtimeMs > MAILBOX_TTL_MS) {
          rmSync(join(dir, name), { force: true });
        }
      } catch {
        /* fail-open */
      }
    }
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ chain, ts: nowMs }));
    renameSync(tmp, file);
  } catch {
    // Fail-open: no cache just means the next fire snapshots again.
  }
}

/**
 * The session mailboxes this hook invocation may drain (possibly none).
 * `deps` is a seam for tests.
 */
export async function resolveHookMailboxes(
  inboxDir: string,
  { sessionId, cwd }: { sessionId?: string; cwd: string | null },
  deps: {
    quick?: () => number[];
    full?: () => Promise<number[]>;
    nowMs?: number;
  } = {},
): Promise<string[]> {
  const quick = deps.quick ?? quickChain;
  const full = deps.full ?? (() => ancestorChain());
  const nowMs = deps.nowMs ?? Date.now();
  try {
    let boxes = selectSessionMailboxes(
      inboxDir,
      quick(),
      cwd,
      undefined,
      nowMs,
    );
    if (boxes.length > 0) return boxes;

    // No live mailbox on this machine → nothing a longer chain could match.
    if (!hasFreshSessionMeta(inboxDir, undefined, nowMs)) return [];

    const cacheFile = sessionId ? pairingCachePath(inboxDir, sessionId) : null;
    if (cacheFile) {
      const cached = readCachedChain(cacheFile, nowMs);
      if (cached) {
        boxes = selectSessionMailboxes(inboxDir, cached, cwd, undefined, nowMs);
        if (boxes.length > 0) return boxes;
      }
    }

    const chain = await full();
    if (cacheFile) writeCachedChain(inboxDir, cacheFile, chain, nowMs);
    return selectSessionMailboxes(inboxDir, chain, cwd, undefined, nowMs);
  } catch {
    return [];
  }
}
