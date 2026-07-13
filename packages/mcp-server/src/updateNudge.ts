import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Hub-driven update nudge. The hub advertises the latest published client
 * version (and optionally a minimum supported one) on join; when this client
 * is behind, we append a one-line note to the first tool result of the
 * session. A per-machine stamp file keeps the routine nudge to roughly once
 * a day; a below-minimum client is warned every session regardless.
 *
 * Everything here fails open: a broken stamp file or unwritable directory
 * must never break a tool response.
 */

export const NUDGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+(?:\.\d+)*)/.exec(v.trim());
  if (!m) return null;
  return m[1]!.split(".").map(Number);
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a) ?? [];
  const pb = parseVersion(b) ?? [];
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

interface NudgeStamp {
  latest: string;
  at: number;
}

function readStamp(stampFile: string): NudgeStamp | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(stampFile, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as NudgeStamp).latest === "string" &&
      typeof (parsed as NudgeStamp).at === "number"
    ) {
      return parsed as NudgeStamp;
    }
  } catch {
    // Missing or corrupt stamp — treat as never nudged.
  }
  return null;
}

function writeStamp(stampFile: string, stamp: NudgeStamp): void {
  try {
    mkdirSync(dirname(stampFile), { recursive: true });
    writeFileSync(stampFile, JSON.stringify(stamp), "utf8");
  } catch {
    // Unwritable stamp just means we may nudge again sooner.
  }
}

const SUGGEST =
  "Let your human know, and suggest the update command that matches how " +
  "Shepherd is installed on this machine (global npm, an npx cache, a " +
  "version manager, …).";

export interface UpdateNudgeOptions {
  /** Version this client is running. */
  current: string;
  /** Latest published version, as advertised by the hub on join. */
  latest?: string | undefined;
  /** Oldest version the hub still supports, if it advertises one. */
  minimum?: string | undefined;
  /** Per-machine cooldown stamp file (e.g. ~/.shepherd/update-nudge.json). */
  stampFile: string;
  nowMs?: number;
}

/** Returns the nudge line to append, or "" when there is nothing to say. */
export function maybeUpdateNudge(opts: UpdateNudgeOptions): string {
  const now = opts.nowMs ?? Date.now();
  if (!parseVersion(opts.current)) return "";
  const latest =
    opts.latest !== undefined && parseVersion(opts.latest)
      ? opts.latest
      : undefined;
  const minimum =
    opts.minimum !== undefined && parseVersion(opts.minimum)
      ? opts.minimum
      : undefined;

  const belowMinimum =
    minimum !== undefined && compareVersions(opts.current, minimum) < 0;
  const behind =
    latest !== undefined && compareVersions(opts.current, latest) < 0;
  if (!belowMinimum && !behind) return "";

  if (!belowMinimum) {
    const stamp = readStamp(opts.stampFile);
    if (
      stamp !== null &&
      compareVersions(latest!, stamp.latest) <= 0 &&
      now - stamp.at < NUDGE_COOLDOWN_MS
    ) {
      return "";
    }
  }
  writeStamp(opts.stampFile, { latest: latest ?? opts.current, at: now });

  if (belowMinimum) {
    const latestPart = latest !== undefined ? ` (latest: ${latest})` : "";
    return (
      `[shepherd] This client (${opts.current}) is below the minimum ` +
      `supported version ${minimum}${latestPart} — coordination may ` +
      `misbehave until it is updated. ${SUGGEST}`
    );
  }
  return (
    `[shepherd] Update available: @korso/shepherd ${latest} ` +
    `(this machine runs ${opts.current}). ${SUGGEST}`
  );
}
