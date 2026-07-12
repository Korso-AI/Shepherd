/**
 * Conservative, byte-preserving installation of Shepherd's canonical Codex
 * hooks into `~/.codex/config.toml`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, TomlDate, type TomlTableWithoutBigInt } from "smol-toml";

/** Outcomes produced by the Codex-specific config installer. */
export type CodexHookInstallStatus =
  "installed" | "already-present" | "skipped";

function canonicalHookBlock(command: string): string {
  const handler = (event: string, matcher?: string) => [
    `[[hooks.${event}]]`,
    ...(matcher === undefined ? [] : [`matcher = ${JSON.stringify(matcher)}`]),
    `[[hooks.${event}.hooks]]`,
    'type = "command"',
    `command = ${JSON.stringify(command)}`,
    "timeout = 20",
    "",
  ];

  return [
    "",
    "# Added by Shepherd: delivers teammate announcements to the agent. Remove to disable.",
    ...handler("UserPromptSubmit"),
    ...handler("SessionStart"),
    ...handler("PreToolUse", "*"),
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

function insertHooksFeature(source: string): string | null {
  const featuresHeader = /^(\s*\[features\]\s*(?:#.*)?)$/m;
  if (!featuresHeader.test(source)) return null;
  return source.replace(featuresHeader, "$1\nhooks = true");
}

/**
 * Install all canonical Shepherd command handlers into Codex's TOML config.
 * Existing bytes are retained; both source and candidate must parse before a
 * write is allowed.
 */
export function installCodexHooks({
  homeDir,
  command,
  hookMarker,
  log,
}: {
  homeDir: string;
  command: string;
  hookMarker: string;
  log: (message: string) => void;
}): CodexHookInstallStatus {
  const configFile = join(homeDir, ".codex", "config.toml");
  const manualHint =
    "Add the hook manually (see the dashboard's Connect screen).";
  const source = existsSync(configFile) ? readFileSync(configFile, "utf8") : "";
  const config = parseConfig(source);

  if (config === null) {
    log(
      `[shepherd] ${configFile} could not be parsed — not touching it. ${manualHint}`,
    );
    return "skipped";
  }
  if (source.includes(hookMarker)) return "already-present";

  const features = config["features"];
  let candidate: string | null;
  if (isTomlTable(features)) {
    if (Object.prototype.hasOwnProperty.call(features, "hooks")) {
      if (features["hooks"] !== true) {
        log(
          `[shepherd] ${configFile} sets features.hooks to a non-true value — respecting it. ${manualHint}`,
        );
        return "skipped";
      }
      candidate = source + canonicalHookBlock(command);
    } else {
      const withFeature = insertHooksFeature(source);
      candidate =
        withFeature === null ? null : withFeature + canonicalHookBlock(command);
    }
  } else if (features === undefined) {
    candidate =
      `${source}${source.length === 0 ? "" : "\n"}[features]\nhooks = true\n` +
      canonicalHookBlock(command);
  } else {
    candidate = null;
  }

  if (candidate === null || parseConfig(candidate) === null) {
    log(
      `[shepherd] ${configFile} could not be safely extended — not touching it. ${manualHint}`,
    );
    return "skipped";
  }

  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, candidate, "utf8");
  return "installed";
}
