/**
 * Byte-preserving TOML planning for Shepherd's canonical Codex hooks.
 */

import { parse, TomlDate, type TomlTableWithoutBigInt } from "smol-toml";

/** Outcomes produced by Codex hook installation and migration. */
export type CodexHookInstallStatus =
  "installed" | "already-present" | "already-attempted" | "skipped";

/** Conclusive config outcomes shared with the migration transaction. */
export type CodexConfigPlan =
  | { kind: "already-canonical" }
  | { kind: "skip"; outcome: "opted-out" | "unsupported-shape" }
  | { kind: "install"; candidate: string };

/** Exact ownership comment shipped in Shepherd's Codex hook blocks. */
export const CODEX_SHEPHERD_COMMENT =
  "# Added by Shepherd: delivers teammate announcements to the agent. Remove to disable.";

function canonicalHandlerBlock(
  event: string,
  command: string,
  matcher?: string,
): string {
  return [
    "[[hooks." + event + "]]",
    ...(matcher === undefined ? [] : ["matcher = " + JSON.stringify(matcher)]),
    "[[hooks." + event + ".hooks]]",
    'type = "command"',
    "command = " + JSON.stringify(command),
    "timeout = 20",
    "",
  ].join("\n");
}

function canonicalHookBlock(command: string): string {
  return [
    "",
    CODEX_SHEPHERD_COMMENT,
    canonicalHandlerBlock("UserPromptSubmit", command),
    canonicalHandlerBlock("SessionStart", command),
    canonicalHandlerBlock("PreToolUse", command, "*"),
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

function installCandidate(
  source: string,
  config: TomlTableWithoutBigInt,
  command: string,
): string | null {
  const features = config["features"];
  let candidate: string | null;
  if (isTomlTable(features)) {
    if (Object.prototype.hasOwnProperty.call(features, "hooks")) {
      candidate =
        features["hooks"] === true
          ? source + canonicalHookBlock(command)
          : null;
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

/**
 * Classify a Codex config and, when safe, build its fresh-install candidate.
 */
export function planCodexConfig(
  source: string,
  command: string,
): CodexConfigPlan {
  const config = parseConfig(source);
  if (config === null) return { kind: "skip", outcome: "unsupported-shape" };
  const features = config["features"];
  if (isTomlTable(features) && features["hooks"] !== undefined) {
    if (features["hooks"] === false) {
      return { kind: "skip", outcome: "opted-out" };
    }
    if (features["hooks"] !== true) {
      return { kind: "skip", outcome: "unsupported-shape" };
    }
  } else if (features !== undefined && !isTomlTable(features)) {
    return { kind: "skip", outcome: "unsupported-shape" };
  }
  if (source.includes(canonicalHookBlock(command))) {
    return { kind: "already-canonical" };
  }
  const candidate = installCandidate(source, config, command);
  return candidate === null
    ? { kind: "skip", outcome: "unsupported-shape" }
    : { kind: "install", candidate };
}

/**
 * Append only missing canonical migration handlers, retaining legacy bytes.
 */
export function appendMissingCodexHandlers(
  source: string,
  command: string,
): string | null {
  const handlers = [
    canonicalHandlerBlock("SessionStart", command),
    canonicalHandlerBlock("PreToolUse", command, "*"),
  ].filter((handler) => !source.includes(handler));
  const candidate =
    handlers.length === 0
      ? source
      : source + (source.endsWith("\n") ? "" : "\n") + handlers.join("");
  return parseConfig(candidate) === null ? null : candidate;
}
