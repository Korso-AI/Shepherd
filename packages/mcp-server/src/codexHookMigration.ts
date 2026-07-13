/**
 * Versioned, crash-safe migration of Shepherd-owned legacy Codex hooks.
 */

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  appendMissingCodexHandlers,
  CODEX_SHEPHERD_COMMENT,
  planCodexConfig,
  type CodexHookInstallStatus,
} from "./codexHookInstall.js";
import {
  acquireMigrationLock,
  atomicWrite,
  ensureMigrationBackup,
  releaseMigrationLock,
} from "./codexHookFs.js";

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

function decodeConfig(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
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
  source: string,
): CodexHookInstallStatus {
  const { paths, command, log } = context;
  const candidate = appendMissingCodexHandlers(source, command);
  if (candidate === null) {
    advanceRecord(paths.recordFile, state, "skipped", "unsupported-shape");
    return "skipped";
  }

  const recordBytes = readFileSync(paths.recordFile);
  const configChanged = candidate !== source;
  ensureMigrationBackup(paths.backupFile, sourceBytes);
  if (!readConfigBytes(paths.configFile).equals(sourceBytes)) return "skipped";
  try {
    if (configChanged) atomicWrite(paths.configFile, candidate);
    advanceRecord(paths.recordFile, state, "installed", "migrated");
  } catch (error) {
    if (!readConfigBytes(paths.configFile).equals(sourceBytes)) {
      atomicWrite(paths.configFile, sourceBytes);
    }
    if (!readFileSync(paths.recordFile).equals(recordBytes)) {
      atomicWrite(paths.recordFile, recordBytes);
    }
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
  const source = decodeConfig(sourceBytes);
  if (source === null) {
    advanceRecord(paths.recordFile, state, "skipped", "unsupported-shape");
    return "skipped";
  }
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
    return migrateLegacy(context, state, sourceBytes, source);
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
  const owner = acquireMigrationLock(paths.lockFile);
  if (owner === null) return "skipped";

  try {
    await Promise.resolve();
    return processLockedConfig(context, expectedFingerprint);
  } catch (error) {
    log("[shepherd] Codex hook migration skipped: " + String(error));
    return "skipped";
  } finally {
    releaseMigrationLock(paths.lockFile, owner, log);
  }
}
