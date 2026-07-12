/**
 * Conservative, byte-preserving installation and migration of Shepherd's
 * canonical Codex hooks in ~/.codex/config.toml.
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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { parse, TomlDate, type TomlTableWithoutBigInt } from "smol-toml";
import { z } from "zod";

/** Outcomes produced by the Codex-specific config installer. */
export type CodexHookInstallStatus =
  "installed" | "already-present" | "already-attempted" | "skipped";

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

const MIGRATION_VERSION = 2;
const STALE_LOCK_MS = 30_000;
const SHEPHERD_COMMENT =
  "# Added by Shepherd: delivers teammate announcements to the agent. Remove to disable.";
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

function canonicalHookBlock(command: string): string {
  const handler = (event: string, matcher?: string) => [
    "[[hooks." + event + "]]",
    ...(matcher === undefined ? [] : ["matcher = " + JSON.stringify(matcher)]),
    "[[hooks." + event + ".hooks]]",
    'type = "command"',
    "command = " + JSON.stringify(command),
    "timeout = 20",
    "",
  ];

  return [
    "",
    SHEPHERD_COMMENT,
    ...handler("UserPromptSubmit"),
    ...handler("SessionStart"),
    ...handler("PreToolUse", "*"),
  ].join("\n");
}

function legacyHookBlock(commandValue: string): string {
  return [
    "",
    SHEPHERD_COMMENT,
    "[[hooks.UserPromptSubmit]]",
    "command = " + commandValue,
    "",
  ].join("\n");
}

function parseConfig(source: string): TomlTableWithoutBigInt | null {
  try {
    return parse(source, { integersAsBigInt: false });
  } catch {
    return null;
  }
}

function isTomlTable(value: unknown): value is TomlTableWithoutBigInt {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof TomlDate)
  );
}

function hasEnabledHooks(config: TomlTableWithoutBigInt): boolean {
  const features = config["features"];
  return isTomlTable(features) && features["hooks"] === true;
}

function insertHooksFeature(source: string): string | null {
  const featuresHeader = /^(\s*\[features\]\s*(?:#.*)?)$/gm;
  let match: RegExpExecArray | null;
  while ((match = featuresHeader.exec(source)) !== null) {
    const insertionPoint = match.index + match[0].length;
    const candidate =
      source.slice(0, insertionPoint) +
      "\nhooks = true" +
      source.slice(insertionPoint);
    const config = parseConfig(candidate);
    if (config !== null && hasEnabledHooks(config)) return candidate;
  }
  return null;
}

function installCandidate(source: string, command: string): string | null {
  const config = parseConfig(source);
  if (config === null) return null;
  const features = config["features"];
  let candidate: string | null;
  if (isTomlTable(features)) {
    if (Object.prototype.hasOwnProperty.call(features, "hooks")) {
      if (features["hooks"] !== true) return null;
      candidate = source + canonicalHookBlock(command);
    } else {
      const withFeature = insertHooksFeature(source);
      candidate =
        withFeature === null ? null : withFeature + canonicalHookBlock(command);
    }
  } else if (features === undefined) {
    candidate =
      source +
      (source.length === 0 ? "" : "\n") +
      "[features]\nhooks = true\n" +
      canonicalHookBlock(command);
  } else {
    candidate = null;
  }
  const parsed = candidate === null ? null : parseConfig(candidate);
  return parsed !== null && hasEnabledHooks(parsed) ? candidate : null;
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

function atomicWrite(path: string, contents: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    "." + basename(path) + "." + process.pid + "." + randomUUID() + ".tmp",
  );
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
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

function advanceRecord(
  recordFile: string,
  state: RecordState,
  status: CodexHookInstallStatus,
  outcome: MigrationOutcome,
): void {
  atomicWrite(recordFile, migrationRecord(state.record, status, outcome));
}

/**
 * Install or migrate all canonical Shepherd handlers while preserving every
 * byte outside Shepherd's exact released legacy block. Never throws.
 */
export async function installCodexHooks({
  homeDir,
  command,
  hookMarker,
  packageVersion,
  log,
}: {
  homeDir: string;
  command: string;
  hookMarker: string;
  packageVersion: string;
  log: (message: string) => void;
}): Promise<CodexHookInstallStatus> {
  const hooksDir = join(homeDir, ".shepherd", "hooks");
  const recordFile = join(hooksDir, "codex.json");
  const lockFile = join(hooksDir, "codex-migration-v2.lock");
  const backupFile = join(hooksDir, "backups", "codex-config-before-v2.toml");
  const configFile = join(homeDir, ".codex", "config.toml");
  const initialRecord = readRecord(recordFile);
  if (initialRecord.kind === "current" || initialRecord.kind === "future") {
    return "already-attempted";
  }
  if (initialRecord.kind === "corrupt") return "skipped";

  let initialBytes: Buffer;
  try {
    initialBytes = readConfigBytes(configFile);
  } catch (error) {
    log(
      "[shepherd] Codex hook migration could not read config: " + String(error),
    );
    return "skipped";
  }
  const expectedFingerprint = fingerprint(initialBytes);
  if (!acquireLock(lockFile)) return "skipped";

  try {
    await Promise.resolve();
    const state = readRecord(recordFile);
    if (state.kind === "current" || state.kind === "future") {
      return "already-attempted";
    }
    if (state.kind === "corrupt") return "skipped";

    const sourceBytes = readConfigBytes(configFile);
    if (fingerprint(sourceBytes) !== expectedFingerprint) return "skipped";
    const source = sourceBytes.toString("utf8");
    const config = parseConfig(source);
    if (config === null) {
      advanceRecord(recordFile, state, "skipped", "unsupported-shape");
      return "skipped";
    }

    const features = config["features"];
    if (isTomlTable(features) && features["hooks"] !== undefined) {
      if (features["hooks"] === false) {
        advanceRecord(recordFile, state, "skipped", "opted-out");
        return "skipped";
      }
      if (features["hooks"] !== true) {
        advanceRecord(recordFile, state, "skipped", "unsupported-shape");
        return "skipped";
      }
    } else if (features !== undefined && !isTomlTable(features)) {
      advanceRecord(recordFile, state, "skipped", "unsupported-shape");
      return "skipped";
    }

    const canonical = canonicalHookBlock(command);
    if (source.includes(canonical)) {
      advanceRecord(recordFile, state, "already-present", "already-canonical");
      return "already-present";
    }

    const pinnedLegacy = legacyHookBlock(
      '["npx", "-y", "--package=@korso/shepherd@' +
        packageVersion +
        '", "shepherd-inbox-hook"]',
    );
    const cachedLegacy = legacyHookBlock(
      '["node", ' +
        JSON.stringify(join(hooksDir, "shepherd-inbox-hook.mjs")) +
        "]",
    );
    const legacyBlocks = [pinnedLegacy, cachedLegacy];
    const ownedBlock = legacyBlocks.find(
      (block) =>
        source.indexOf(block) >= 0 &&
        source.indexOf(block) === source.lastIndexOf(block),
    );

    if (state.kind === "legacy" && ownedBlock !== undefined) {
      const candidate = source.replace(ownedBlock, canonical);
      if (parseConfig(candidate) === null) {
        advanceRecord(recordFile, state, "skipped", "unsupported-shape");
        return "skipped";
      }
      ensureBackup(backupFile, sourceBytes);
      atomicWrite(configFile, candidate);
      try {
        advanceRecord(recordFile, state, "installed", "migrated");
      } catch (error) {
        atomicWrite(configFile, sourceBytes);
        throw error;
      }
      return "installed";
    }

    if (
      ownedBlock !== undefined ||
      source.includes(SHEPHERD_COMMENT) ||
      source.includes(hookMarker)
    ) {
      advanceRecord(recordFile, state, "already-present", "ambiguous");
      return "already-present";
    }
    if (state.kind === "legacy") {
      advanceRecord(recordFile, state, "skipped", "user-removed");
      return "skipped";
    }

    const candidate = installCandidate(source, command);
    if (candidate === null) {
      advanceRecord(recordFile, state, "skipped", "unsupported-shape");
      return "skipped";
    }
    atomicWrite(configFile, candidate);
    advanceRecord(recordFile, state, "installed", "already-canonical");
    return "installed";
  } catch (error) {
    log("[shepherd] Codex hook migration skipped: " + String(error));
    return "skipped";
  } finally {
    try {
      unlinkSync(lockFile);
    } catch (error) {
      log(
        "[shepherd] Codex hook migration lock cleanup failed: " + String(error),
      );
    }
  }
}
