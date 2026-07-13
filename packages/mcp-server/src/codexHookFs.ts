/**
 * Crash-safe filesystem primitives for the Codex hook migration.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

const STALE_LOCK_MS = 30_000;
const lockSchema = z.object({
  pid: z.number().int().positive(),
  createdAt: z.string(),
  owner: z.string().min(1).optional(),
});

interface LockSnapshot {
  bytes: Buffer;
  owner: string | null;
  reclaimable: boolean;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : undefined;
}

function modeOf(path: string): number {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return 0o600;
  }
}

function syncParent(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(dirname(path), "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function durableTemp(
  path: string,
  contents: string | Buffer,
  mode: number,
): void {
  const descriptor = openSync(path, "wx", mode);
  try {
    writeFileSync(descriptor, contents);
    fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Atomically replace a file, preserving its mode and syncing the rename.
 */
export function atomicWrite(path: string, contents: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    "." + basename(path) + "." + process.pid + "." + randomUUID() + ".tmp",
  );
  try {
    durableTemp(temporary, contents, modeOf(path));
    renameSync(temporary, path);
    syncParent(path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temp may already have been renamed or never created.
    }
    throw error;
  }
}

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function lockSnapshot(lockFile: string): LockSnapshot | null {
  try {
    const bytes = readFileSync(lockFile);
    const modifiedAt = statSync(lockFile).mtimeMs;
    let owner: string | null = null;
    let reclaimable = false;
    try {
      const decoded: unknown = JSON.parse(bytes.toString("utf8"));
      const parsed = lockSchema.safeParse(decoded);
      if (parsed.success) {
        owner = parsed.data.owner ?? null;
        const createdAt = Date.parse(parsed.data.createdAt);
        const ageBasis = Number.isFinite(createdAt) ? createdAt : modifiedAt;
        reclaimable =
          Date.now() - ageBasis > STALE_LOCK_MS &&
          !processIsLive(parsed.data.pid);
      }
    } catch {
      // A lock without a proven-dead recorded PID is never safe to reclaim.
    }
    return { bytes, owner, reclaimable };
  } catch {
    return null;
  }
}

function lockContents(owner: string): string {
  return JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
    owner,
  });
}

function createOwnedLock(lockFile: string, owner: string): boolean {
  const temporary = lockFile + ".owner-" + owner + ".tmp";
  try {
    durableTemp(temporary, lockContents(owner), 0o600);
    linkSync(temporary, lockFile);
    return true;
  } catch {
    return false;
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // Only this claimant's unique unpublished name is safe to remove.
    }
  }
}

function ownedBy(lockFile: string, owner: string): boolean {
  try {
    const decoded: unknown = JSON.parse(readFileSync(lockFile, "utf8"));
    const parsed = lockSchema.safeParse(decoded);
    return parsed.success && parsed.data.owner === owner;
  } catch {
    return false;
  }
}

function removeOwnedLock(lockFile: string, owner: string): void {
  if (ownedBy(lockFile, owner)) unlinkSync(lockFile);
}

function snapshotMatches(
  current: LockSnapshot | null,
  expected: LockSnapshot,
): boolean {
  return (
    current !== null &&
    current.reclaimable &&
    current.bytes.equals(expected.bytes)
  );
}

function nextReclaimClaim(rootClaim: string, snapshot: LockSnapshot): string {
  const generation = createHash("sha256").update(snapshot.bytes).digest("hex");
  return rootClaim + ".generation-" + generation;
}

function acquireReclaimClaim(rootClaim: string, owner: string): string | null {
  let claimFile = rootClaim;
  for (let generation = 0; generation < 32; generation += 1) {
    if (createOwnedLock(claimFile, owner)) return claimFile;
    const snapshot = lockSnapshot(claimFile);
    if (snapshot === null || !snapshot.reclaimable || snapshot.owner === null) {
      return null;
    }
    claimFile = nextReclaimClaim(rootClaim, snapshot);
  }
  return null;
}

function replaceStaleLock(
  lockFile: string,
  claimFile: string,
  owner: string,
  expected: LockSnapshot,
): boolean {
  const replacement = lockFile + ".replacement-" + owner;
  let published = false;
  try {
    durableTemp(replacement, lockContents(owner), 0o600);
    if (!ownedBy(claimFile, owner)) return false;
    if (!snapshotMatches(lockSnapshot(lockFile), expected)) return false;
    renameSync(replacement, lockFile);
    published = true;
    syncParent(lockFile);
    if (ownedBy(claimFile, owner)) return true;
    removeOwnedLock(lockFile, owner);
    return false;
  } catch {
    if (published) removeOwnedLock(lockFile, owner);
    return false;
  } finally {
    try {
      unlinkSync(replacement);
    } catch {
      // The replacement may have been published or never created.
    }
  }
}

/**
 * Acquire an exclusive lock, atomically replacing only an unchanged stale
 * snapshot while append-only claim generations serialize reclaimers using
 * atomic no-overwrite publication.
 */
export function acquireMigrationLock(lockFile: string): string | null {
  mkdirSync(dirname(lockFile), { recursive: true });
  const owner = randomUUID();
  if (createOwnedLock(lockFile, owner)) return owner;
  const snapshot = lockSnapshot(lockFile);
  if (snapshot === null || !snapshot.reclaimable) return null;

  const claimFile = acquireReclaimClaim(lockFile + ".reclaim", owner);
  if (claimFile === null) return null;
  try {
    return replaceStaleLock(lockFile, claimFile, owner, snapshot)
      ? owner
      : null;
  } finally {
    try {
      removeOwnedLock(claimFile, owner);
    } catch {
      // A cleanup failure leaves a fail-closed claim, never an unlocked gap.
    }
  }
}

/**
 * Release a migration lock only when its persisted owner token still matches.
 */
export function releaseMigrationLock(
  lockFile: string,
  owner: string,
  log: (message: string) => void,
): void {
  try {
    removeOwnedLock(lockFile, owner);
  } catch (error) {
    log(
      "[shepherd] Codex hook migration lock cleanup failed: " + String(error),
    );
  }
}

function validateBackup(backupFile: string, source: Buffer): void {
  if (!readFileSync(backupFile).equals(source)) {
    throw new Error("existing Codex migration backup does not match config");
  }
  chmodSync(backupFile, 0o600);
}

/**
 * Publish a durable user-only backup without ever opening the permanent path
 * for writing or overwriting a concurrent publisher.
 */
export function ensureMigrationBackup(
  backupFile: string,
  source: Buffer,
): void {
  const backupDirectory = dirname(backupFile);
  mkdirSync(backupDirectory, { recursive: true });
  syncParent(backupDirectory);
  if (existsSync(backupFile)) {
    validateBackup(backupFile, source);
    syncParent(backupFile);
    return;
  }

  const temporary =
    backupFile + "." + process.pid + "." + randomUUID() + ".tmp";
  try {
    durableTemp(temporary, source, 0o600);
    try {
      linkSync(temporary, backupFile);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      validateBackup(backupFile, source);
    }
    syncParent(backupFile);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // A failed temp creation leaves nothing to clean.
    }
  }
}
