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
import { randomUUID } from "node:crypto";
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
  stale: boolean;
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
    let stale = Date.now() - modifiedAt > STALE_LOCK_MS;
    try {
      const decoded: unknown = JSON.parse(bytes.toString("utf8"));
      const parsed = lockSchema.safeParse(decoded);
      if (parsed.success) {
        const createdAt = Date.parse(parsed.data.createdAt);
        if (Number.isFinite(createdAt)) {
          stale =
            Date.now() - createdAt > STALE_LOCK_MS &&
            !processIsLive(parsed.data.pid);
        }
      }
    } catch {
      // Malformed locks fall back to their filesystem modification time.
    }
    return { bytes, stale };
  } catch {
    return null;
  }
}

function createOwnedLock(lockFile: string, owner: string): boolean {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(lockFile, "wx", 0o600);
    writeFileSync(
      descriptor,
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        owner,
      }),
      "utf8",
    );
    fsyncSync(descriptor);
    closeSync(descriptor);
    return true;
  } catch {
    if (descriptor !== null) closeSync(descriptor);
    return false;
  }
}

function restoreQuarantine(lockFile: string, quarantine: string): boolean {
  try {
    if (existsSync(lockFile)) return false;
    renameSync(quarantine, lockFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire an exclusive lock, reclaiming only the exact stale snapshot moved
 * into this claimant's unique quarantine file.
 */
export function acquireMigrationLock(lockFile: string): string | null {
  mkdirSync(dirname(lockFile), { recursive: true });
  const owner = randomUUID();
  if (createOwnedLock(lockFile, owner)) return owner;
  const snapshot = lockSnapshot(lockFile);
  if (snapshot === null || !snapshot.stale) return null;

  const quarantine = lockFile + ".quarantine-" + owner;
  try {
    renameSync(lockFile, quarantine);
  } catch {
    return null;
  }
  let retainQuarantine = false;
  try {
    const moved = readFileSync(quarantine);
    if (!moved.equals(snapshot.bytes)) {
      retainQuarantine = !restoreQuarantine(lockFile, quarantine);
      return null;
    }
    return createOwnedLock(lockFile, owner) ? owner : null;
  } finally {
    if (!retainQuarantine && existsSync(quarantine)) unlinkSync(quarantine);
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
    const decoded: unknown = JSON.parse(readFileSync(lockFile, "utf8"));
    const parsed = lockSchema.safeParse(decoded);
    if (parsed.success && parsed.data.owner === owner) unlinkSync(lockFile);
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
  mkdirSync(dirname(backupFile), { recursive: true });
  if (existsSync(backupFile)) {
    validateBackup(backupFile, source);
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
