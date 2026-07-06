/**
 * Device identity cache: the small local store that lets a Shepherd client
 * launched OUTSIDE a git work tree reuse the human name git last reported on
 * this machine.
 *
 * Why this exists: identity is resolved per launch as `HUMAN` env override →
 * git detection (from the launch cwd) → fallback. When the client starts from a
 * non-git parent directory (e.g. a multi-repo workspace root), git detection
 * returns null and the human would otherwise fall back to a random generated
 * name — a different name every launch. Caching the last git-detected name per
 * OS user gives those launches a stable, recognizable identity.
 *
 * Scope: ONE name per device OS user, shared across repos — keyed only by the
 * cache file location under the user's home dir, with no repo/cwd dimension.
 *
 * Everything here is FAIL-OPEN: a disk/parse error never throws into startup.
 * Worst case the cache is ignored and resolveContext falls back exactly as it
 * did before this module existed.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** On-disk shape of the identity cache. Intentionally minimal. */
interface IdentityCacheFile {
  human?: string;
}

/**
 * The default cache path, used when no explicit path is injected. Computed
 * identically for the same OS user on the same machine, so every Shepherd
 * launch shares one file with zero configuration. Falls back to the OS temp
 * dir if the home directory can't be resolved (mirrors {@link inbox.ts}).
 */
export function defaultIdentityCachePath(): string {
  let base = "";
  try {
    base = homedir();
  } catch {
    base = "";
  }
  if (!base) base = tmpdir();
  return join(base, ".shepherd", "identity.json");
}

/**
 * Read the cached human name, or null when absent/empty/unreadable/malformed.
 * Never throws. A blank or whitespace-only stored value is treated as absent.
 */
export function readCachedHuman(
  filePath: string = defaultIdentityCachePath(),
): string | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    // Missing file or read error: nothing cached.
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as IdentityCacheFile;
    const human = typeof parsed?.human === "string" ? parsed.human.trim() : "";
    return human.length > 0 ? human : null;
  } catch {
    // Corrupt JSON: ignore it; the next write overwrites it cleanly.
    return null;
  }
}

/**
 * Persist `human` as the device's cached name. Creates the parent dir if
 * needed. A blank/whitespace-only value is ignored (never overwrites a good
 * cache with garbage). Fail-open: any error is swallowed.
 */
export function writeCachedHuman(
  human: string,
  filePath: string = defaultIdentityCachePath(),
): void {
  if (typeof human !== "string" || human.trim().length === 0) return;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const payload = JSON.stringify({ human } satisfies IdentityCacheFile);
    writeFileSync(filePath, payload + "\n", "utf8");
  } catch {
    // Fail-open: a missed cache write just means the next non-git launch falls
    // back to a generated name, exactly the pre-cache behaviour.
  }
}
