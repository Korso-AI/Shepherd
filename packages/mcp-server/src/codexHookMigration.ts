/**
 * Versioned, crash-safe migration of Shepherd-owned legacy Codex hooks.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
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
import {
  appendMissingCodexHandlers,
  CODEX_SHEPHERD_COMMENT,
  planCodexConfig,
  type CodexHookInstallStatus,
} from "./codexHookInstall.js";

type MigrationOutcome =
  | "migrated"
  | "already-canonical"
  | "user-removed"
  | "ambiguous"
  | "opted-out"
  | "unsupported-shape";

interface RecordState {
  kind: "none" | "legacy" | "current" | "future" | "corrupt";
  record?: Record<string, unknown>;
}

interface MigrationPaths {
  hooksDir: string;
  recordFile: string;
  lockFile: string;
  backupFile: string;
  configFile: string;
}

interface MigrationContext {
  paths: MigrationPaths;
  command: string;
  hookMarker: string;
  log: (message: string) => void;
}

const MIGRATION_VERSION = 2;
const STALE_LOCK_MS = 30_000;
const migrationOutcomeSchema = z.enum([
  "migrated",
  "already-canonical",
  "user-removed",
  "ambiguous",
  "opted-out",
  "unsupported-shape",
]);
const recordSchema = z
  .object({
    status: z.string(),
    at: z.string(),
    migrationVersion: z.number().int().nonnegative().optional(),
    migrationOutcome: migrationOutcomeSchema.optional(),
  })
  .passthrough();
const lockSchema = z.object({
  pid: z.number().int().positive(),
  createdAt: z.string(),
});

function migrationPaths(homeDir: string): MigrationPaths {
  const hooksDir = join(homeDir, ".shepherd", "hooks");
  return {
    hooksDir,
    recordFile: join(hooksDir, "codex.json"),
    lockFile: join(hooksDir, "codex-migration-v2.lock"),
    backupFile: join(hooksDir, "backups", "codex-config-before-v2.toml"),
    configFile: join(homeDir, ".codex", "config.toml"),
  };
}

function readRecord(recordFile: string): RecordState {
  if (!existsSync(recordFile)) return { kind: "none" };
  try {
    const decoded: unknown = JSON.parse(readFileSync(recordFile, "utf8"));
    const parsed = recordSchema.safeParse(decoded);
    if (!parsed.success) return { kind: "corrupt" };
    const record: Record<string, unknown> = parsed.data;
    const version = parsed.data.migrationVersion;
    if (version === undefined || version < MIGRATION_VERSION) {
      return { kind: "legacy", record };
    }
    if (version > MIGRATION_VERSION) return { kind: "future", record };
    return parsed.data.migrationOutcome === undefined
      ? { kind: "corrupt" }
      : { kind: "current", record };
  } catch {
    return { kind: "corrupt" };
  }
}

function migrationRecord(
  prior: Record<string, unknown> | undefined,
  status: CodexHookInstallStatus,
  outcome: MigrationOutcome,
): string {
  return (
    JSON.stringify(
      {
        ...prior,
        status:
          typeof prior?.["status"] === "string" ? prior["status"] : status,
        at:
          typeof prior?.["at"] === "string"
            ? prior["at"]
            : new Date().toISOString(),
        migrationVersion: MIGRATION_VERSION,
        migrationOutcome: outcome,
      },
      null,
      2,
    ) + "\n"
  );
}

function fingerprint(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readConfigBytes(configFile: string): Buffer {
  return existsSync(configFile) ? readFileSync(configFile) : Buffer.alloc(0);
}

function syncFile(path: string): void {
  const descriptor = openSync(path, "r+");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fileMode(path: string): number {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return 0o600;
  }
}

function atomicWrite(
  path: string,
  contents: string | Buffer,
  mode = fileMode(path),
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    "." + basename(path) + "." + process.pid + "." + randomUUID() + ".tmp",
  );
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", mode);
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
    syncFile(path);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
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
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

function staleDeadLock(lockFile: string): boolean {
  try {
    const decoded: unknown = JSON.parse(readFileSync(lockFile, "utf8"));
    const parsed = lockSchema.safeParse(decoded);
    if (!parsed.success) return false;
    const createdAt = Date.parse(parsed.data.createdAt);
    return (
      Number.isFinite(createdAt) &&
      Date.now() - createdAt > STALE_LOCK_MS &&
      !processIsLive(parsed.data.pid)
    );
  } catch {
    return false;
  }
}

function acquireLock(lockFile: string, retried = false): boolean {
  mkdirSync(dirname(lockFile), { recursive: true });
  let descriptor: number | null = null;
  try {
    descriptor = openSync(lockFile, "wx", 0o600);
    writeFileSync(
      descriptor,
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      "utf8",
    );
    fsyncSync(descriptor);
    closeSync(descriptor);
    return true;
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    if (
      !retried &&
      error instanceof Error &&
      "code" in error &&
      error.code === "EEXIST" &&
      staleDeadLock(lockFile)
    ) {
      unlinkSync(lockFile);
      return acquireLock(lockFile, true);
    }
    return false;
  }
}

function ensureBackup(backupFile: string, source: Buffer): void {
  mkdirSync(dirname(backupFile), { recursive: true });
  if (existsSync(backupFile)) {
    if (!readFileSync(backupFile).equals(source)) {
      throw new Error("existing Codex migration backup does not match config");
    }
    chmodSync(backupFile, 0o600);
    return;
  }
  const descriptor = openSync(backupFile, "wx", 0o600);
  try {
    writeFileSync(descriptor, source);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(backupFile, 0o600);
}

function advanceRecord(
  recordFile: string,
  state: RecordState,
  status: CodexHookInstallStatus,
  outcome: MigrationOutcome,
): void {
  atomicWrite(recordFile, migrationRecord(state.record, status, outcome));
}

function legacyHookBlock(commandValue: string): string {
  return [
    "",
    CODEX_SHEPHERD_COMMENT,
    "[[hooks.UserPromptSubmit]]",
    "command = " + commandValue,
    "",
  ].join("\n");
}

function exactOwnedLegacyBlock(
  source: string,
  hooksDir: string,
): string | undefined {
  const semver = "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)";
  const pinned = new RegExp(
    '^command = (\\["npx", "-y", "--package=@korso/shepherd@' +
      semver +
      '", "shepherd-inbox-hook"\\])$',
    "gm",
  );
  const candidates = Array.from(source.matchAll(pinned), (match) =>
    legacyHookBlock(match[1]),
  );
  candidates.push(
    legacyHookBlock(
      '["node", ' +
        JSON.stringify(join(hooksDir, "shepherd-inbox-hook.mjs")) +
        "]",
    ),
  );
  const exact = candidates.filter(
    (block) =>
      source.indexOf(block) >= 0 &&
      source.indexOf(block) === source.lastIndexOf(block),
  );
  return exact.length === 1 ? exact[0] : undefined;
}

function migrateLegacy(
  context: MigrationContext,
  state: RecordState,
  sourceBytes: Buffer,
): CodexHookInstallStatus {
  const { paths, command, log } = context;
  const source = sourceBytes.toString("utf8");
  const candidate = appendMissingCodexHandlers(source, command);
  if (candidate === null) {
    advanceRecord(paths.recordFile, state, "skipped", "unsupported-shape");
    return "skipped";
  }

  const recordBytes = readFileSync(paths.recordFile);
  const configMode = fileMode(paths.configFile);
  const recordMode = fileMode(paths.recordFile);
  const configChanged = candidate !== source;
  ensureBackup(paths.backupFile, sourceBytes);
  if (!readConfigBytes(paths.configFile).equals(sourceBytes)) return "skipped";
  if (configChanged) atomicWrite(paths.configFile, candidate, configMode);
  try {
    advanceRecord(paths.recordFile, state, "installed", "migrated");
  } catch (error) {
    if (configChanged) atomicWrite(paths.configFile, sourceBytes, configMode);
    atomicWrite(paths.recordFile, recordBytes, recordMode);
    throw error;
  }
  log(
    "[shepherd] Migrated Codex hooks. Persistent backup: " +
      paths.backupFile +
      "; you may remove it after validation.",
  );
  return "installed";
}

function processLockedConfig(
  context: MigrationContext,
  expectedFingerprint: string,
): CodexHookInstallStatus {
  const { paths, command, hookMarker } = context;
  const state = readRecord(paths.recordFile);
  if (state.kind === "current" || state.kind === "future") {
    return "already-attempted";
  }
  if (state.kind === "corrupt") return "skipped";

  const sourceBytes = readConfigBytes(paths.configFile);
  if (fingerprint(sourceBytes) !== expectedFingerprint) return "skipped";
  const source = sourceBytes.toString("utf8");
  const plan = planCodexConfig(source, command);
  if (plan.kind === "skip") {
    advanceRecord(paths.recordFile, state, "skipped", plan.outcome);
    return "skipped";
  }
  if (plan.kind === "already-canonical") {
    advanceRecord(
      paths.recordFile,
      state,
      "already-present",
      "already-canonical",
    );
    return "already-present";
  }

  const ownedBlock = exactOwnedLegacyBlock(source, paths.hooksDir);
  if (state.kind === "legacy" && ownedBlock !== undefined) {
    return migrateLegacy(context, state, sourceBytes);
  }
  if (
    ownedBlock !== undefined ||
    source.includes(CODEX_SHEPHERD_COMMENT) ||
    source.includes(hookMarker)
  ) {
    advanceRecord(paths.recordFile, state, "already-present", "ambiguous");
    return "already-present";
  }
  if (state.kind === "legacy") {
    advanceRecord(paths.recordFile, state, "skipped", "user-removed");
    return "skipped";
  }
  atomicWrite(paths.configFile, plan.candidate);
  advanceRecord(paths.recordFile, state, "installed", "already-canonical");
  return "installed";
}

/**
 * Install or migrate canonical Shepherd handlers with a versioned transaction.
 */
export async function installCodexHooks({
  homeDir,
  command,
  hookMarker,
  log,
}: {
  homeDir: string;
  command: string;
  hookMarker: string;
  log: (message: string) => void;
}): Promise<CodexHookInstallStatus> {
  const paths = migrationPaths(homeDir);
  const context = { paths, command, hookMarker, log };
  const initialRecord = readRecord(paths.recordFile);
  if (initialRecord.kind === "current" || initialRecord.kind === "future") {
    return "already-attempted";
  }
  if (initialRecord.kind === "corrupt") return "skipped";

  let initialBytes: Buffer;
  try {
    initialBytes = readConfigBytes(paths.configFile);
  } catch (error) {
    log(
      "[shepherd] Codex hook migration could not read config: " + String(error),
    );
    return "skipped";
  }
  const expectedFingerprint = fingerprint(initialBytes);
  if (!acquireLock(paths.lockFile)) return "skipped";

  try {
    await Promise.resolve();
    return processLockedConfig(context, expectedFingerprint);
  } catch (error) {
    log("[shepherd] Codex hook migration skipped: " + String(error));
    return "skipped";
  } finally {
    try {
      unlinkSync(paths.lockFile);
    } catch (error) {
      log(
        "[shepherd] Codex hook migration lock cleanup failed: " + String(error),
      );
    }
  }
}
