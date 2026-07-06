/**
 * Layer 4 of the zero-setup flow: install the `shepherd-inbox-hook` into the
 * connecting client's own configuration automatically, the first time Shepherd
 * runs on this machine under that client — the same pattern established tools
 * (e.g. superpowers) use. The hook gives PASSIVE delivery: announcements and
 * the link nudge reach the model without waiting for a Shepherd tool call.
 *
 * Consent model: installation is disclosed on the dashboard's Connect screen
 * (where the user chose to install Shepherd) and opt-out via
 * SHEPHERD_NO_AUTO_HOOKS=1. The install itself follows strict safety rules:
 *
 *  - ADDITIVE ONLY: existing config keys/entries are never modified, removed,
 *    or reordered — we only append our own entries.
 *  - Never touch a file we can't confidently parse or extend: skip and print a
 *    stderr notice pointing at the manual snippet instead.
 *  - AT MOST ONE ATTEMPT per machine+client, recorded under ~/.shepherd/hooks.
 *    If the user later removes the hook, that removal is respected forever.
 *  - A manual install (the hook command already present) is detected and left
 *    exactly as the user wrote it.
 *  - Fail-open: any error is a skip with a stderr line, never a crash.
 *
 * The client is identified from the MCP initialize handshake's clientInfo —
 * protocol-level and universal, no environment sniffing.
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The clients we know how to install into. */
export type ClientKind = "claude" | "codex" | "pi" | "cursor" | "unknown";

/**
 * Map an MCP `clientInfo.name` onto a known client. Substring matching except
 * for "pi", which is matched as a whole word/token so e.g. "rapid" or
 * "capybara" can never read as Pi.
 */
export function detectClient(clientName: string | undefined): ClientKind {
  const name = (clientName ?? "").toLowerCase();
  if (!name) return "unknown";
  if (name.includes("claude")) return "claude";
  if (name.includes("codex")) return "codex";
  if (name.includes("cursor")) return "cursor";
  if (/(^|[^a-z0-9])pi([^a-z0-9]|$)/.test(name)) return "pi";
  return "unknown";
}

/** What a single auto-install attempt concluded. */
export interface InstallResult {
  client: ClientKind;
  status:
    | "installed" // we wrote the hook into the client config
    | "already-present" // a (manual) install was found — untouched
    | "already-attempted" // a prior run recorded an attempt — never retry
    | "skipped" // couldn't do it safely (unparseable/conflicting/fs error)
    | "unsupported" // unknown client, or one we don't auto-install into
    | "disabled"; // SHEPHERD_NO_AUTO_HOOKS opt-out
}

/** Must match the Connect screen's manual snippet exactly (one source of truth
 * for what "the hook" is; a manual paste and an auto-install must dedupe). */
export const HOOK_COMMAND = "npx -y --package=@korso/shepherd shepherd-inbox-hook";
const HOOK_MARKER = "shepherd-inbox-hook";

const CODEX_HOOK_BLOCK = [
  "",
  "# Added by Shepherd: delivers teammate announcements to the agent. Remove to disable.",
  "[[hooks.UserPromptSubmit]]",
  'command = ["npx", "-y", "--package=@korso/shepherd", "shepherd-inbox-hook"]',
  "",
].join("\n");

/**
 * Attempt the once-per-machine+client hook install. Never throws.
 *
 * @param clientName - `clientInfo.name` from the MCP initialize handshake.
 * @param homeDir - seam for tests; the real home directory otherwise.
 * @param disabled - the SHEPHERD_NO_AUTO_HOOKS opt-out.
 * @param extensionSource - seam for tests; the bundled Pi extension file.
 * @param log - stderr sink (stdout is the MCP protocol channel).
 */
export async function autoInstallHooks({
  clientName,
  homeDir = homedir(),
  disabled = false,
  extensionSource,
  log = (msg: string) => console.error(msg),
}: {
  clientName: string | undefined;
  homeDir?: string;
  disabled?: boolean;
  extensionSource?: string;
  log?: (msg: string) => void;
}): Promise<InstallResult> {
  const client = detectClient(clientName);
  try {
    if (disabled) return { client, status: "disabled" };
    if (client === "unknown") {
      return { client, status: "unsupported" };
    }

    // One attempt per machine+client, ever. A recorded attempt also encodes
    // "the user may have removed it since" — which we must respect, so the
    // record is checked BEFORE looking at the client config.
    const recordFile = join(homeDir, ".shepherd", "hooks", `${client}.json`);
    if (existsSync(recordFile)) return { client, status: "already-attempted" };

    let status: InstallResult["status"];
    if (client === "claude") {
      status = installClaude(homeDir, log);
    } else if (client === "codex") {
      status = installCodex(homeDir, log);
    } else if (client === "cursor") {
      status = installCursor(homeDir, log);
    } else {
      status = installPi(homeDir, extensionSource, log);
    }

    // Record every decisive outcome — installed, found manual, or safely
    // skipped — so the user's config is never re-inspected on every boot.
    mkdirSync(dirname(recordFile), { recursive: true });
    writeFileSync(
      recordFile,
      JSON.stringify({ status, at: new Date().toISOString() }, null, 2) + "\n",
      "utf8"
    );
    if (status === "installed") {
      log(
        `[shepherd] Installed the announcement-delivery hook for ${client} ` +
          `(disable by removing it, or set SHEPHERD_NO_AUTO_HOOKS=1 to never auto-install).`
      );
    }
    return { client, status };
  } catch (err) {
    log(
      `[shepherd] hook auto-install skipped: ${err instanceof Error ? err.message : String(err)}`
    );
    return { client, status: "skipped" };
  }
}

// ---------------------------------------------------------------------------
// Claude Code: ~/.claude/settings.json (JSON, structural additive merge)
// ---------------------------------------------------------------------------

function installClaude(homeDir: string, log: (msg: string) => void): InstallResult["status"] {
  const settingsFile = join(homeDir, ".claude", "settings.json");

  let raw = "";
  if (existsSync(settingsFile)) {
    raw = readFileSync(settingsFile, "utf8");
    if (raw.includes(HOOK_MARKER)) return "already-present";
  }

  let settings: Record<string, unknown> = {};
  if (raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("settings.json is not a JSON object");
      }
      settings = parsed as Record<string, unknown>;
    } catch {
      log(
        `[shepherd] ${settingsFile} could not be parsed — not touching it. ` +
          `Add the hook manually (see the dashboard's Connect screen).`
      );
      return "skipped";
    }
  }

  // hooks must be an extendable object, and each event an extendable array —
  // anything else means a config shape we don't understand: leave it alone.
  const hooks = (settings["hooks"] ??= {});
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    log(`[shepherd] ${settingsFile} has an unexpected "hooks" shape — not touching it.`);
    return "skipped";
  }
  const hooksObj = hooks as Record<string, unknown>;
  for (const event of ["SessionStart", "PreToolUse"]) {
    const existing = (hooksObj[event] ??= []);
    if (!Array.isArray(existing)) {
      log(`[shepherd] ${settingsFile} has an unexpected hooks.${event} shape — not touching it.`);
      return "skipped";
    }
  }

  (hooksObj["SessionStart"] as unknown[]).push({
    hooks: [{ type: "command", command: HOOK_COMMAND }],
  });
  (hooksObj["PreToolUse"] as unknown[]).push({
    matcher: "*",
    hooks: [{ type: "command", command: HOOK_COMMAND }],
  });

  mkdirSync(dirname(settingsFile), { recursive: true });
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return "installed";
}

// ---------------------------------------------------------------------------
// Codex: ~/.codex/config.toml (TOML, conservative text-level append)
// ---------------------------------------------------------------------------
// No TOML parser is shipped, so edits are append/insert-only with hard bails:
// any shape we can't extend by appending valid TOML is skipped untouched.

function installCodex(homeDir: string, log: (msg: string) => void): InstallResult["status"] {
  const configFile = join(homeDir, ".codex", "config.toml");
  const manualHint = "Add the hook manually (see the dashboard's Connect screen).";

  if (!existsSync(configFile)) {
    mkdirSync(dirname(configFile), { recursive: true });
    writeFileSync(configFile, `[features]\nhooks = true\n${CODEX_HOOK_BLOCK}`, "utf8");
    return "installed";
  }

  const toml = readFileSync(configFile, "utf8");
  if (toml.includes(HOOK_MARKER)) return "already-present";

  // A non-array [hooks.UserPromptSubmit] table exists: appending our
  // array-of-tables entry would make the file invalid TOML. Bail.
  if (/^\s*\[hooks\.UserPromptSubmit\]\s*$/m.test(toml)) {
    log(`[shepherd] ${configFile} defines [hooks.UserPromptSubmit] — not touching it. ${manualHint}`);
    return "skipped";
  }

  if (/^\s*\[features\]/m.test(toml)) {
    const hooksKey = /^\s*hooks\s*=\s*(.+)$/m.exec(toml);
    if (hooksKey && hooksKey[1].trim() !== "true") {
      // The user explicitly set hooks = false (or something else): their call.
      log(`[shepherd] ${configFile} sets hooks = ${hooksKey[1].trim()} — respecting it. ${manualHint}`);
      return "skipped";
    }
    let updated = toml;
    if (!hooksKey) {
      // Insert the flag directly under the [features] header — the only spot
      // that is guaranteed to be inside that table.
      updated = toml.replace(/^(\s*\[features\]\s*)$/m, `$1\nhooks = true`);
    }
    writeFileSync(configFile, updated + CODEX_HOOK_BLOCK, "utf8");
    return "installed";
  }

  // No [features] table anywhere: append both (a trailing table header ends
  // whatever table the file was in — valid TOML).
  writeFileSync(configFile, `${toml}\n[features]\nhooks = true\n${CODEX_HOOK_BLOCK}`, "utf8");
  return "installed";
}

// ---------------------------------------------------------------------------
// Cursor: ~/.cursor/hooks.json (JSON, structural additive merge)
// ---------------------------------------------------------------------------
// Verified by spike (2026-07-03, Cursor 3.9.16): a beforeSubmitPrompt hook's
// top-level `additionalContext` reply reaches the agent's model context.
// ONLY that event is wired — the inbox drain CONSUMES announcements, so wiring
// an event whose output can't reach the model (unverified: afterFileEdit etc.)
// would silently destroy messages instead of delivering them.

function installCursor(homeDir: string, log: (msg: string) => void): InstallResult["status"] {
  const hooksFile = join(homeDir, ".cursor", "hooks.json");

  let raw = "";
  if (existsSync(hooksFile)) {
    raw = readFileSync(hooksFile, "utf8");
    if (raw.includes(HOOK_MARKER)) return "already-present";
  }

  let config: Record<string, unknown> = {};
  if (raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("hooks.json is not a JSON object");
      }
      config = parsed as Record<string, unknown>;
    } catch {
      log(
        `[shepherd] ${hooksFile} could not be parsed — not touching it. ` +
          `Add the hook manually (see the dashboard's Connect screen).`
      );
      return "skipped";
    }
  }

  config["version"] ??= 1;
  const hooks = (config["hooks"] ??= {});
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    log(`[shepherd] ${hooksFile} has an unexpected "hooks" shape — not touching it.`);
    return "skipped";
  }
  const hooksObj = hooks as Record<string, unknown>;
  const entries = (hooksObj["beforeSubmitPrompt"] ??= []);
  if (!Array.isArray(entries)) {
    log(
      `[shepherd] ${hooksFile} has an unexpected hooks.beforeSubmitPrompt shape — not touching it.`
    );
    return "skipped";
  }

  entries.push({ command: HOOK_COMMAND });

  mkdirSync(dirname(hooksFile), { recursive: true });
  writeFileSync(hooksFile, JSON.stringify(config, null, 2) + "\n", "utf8");
  return "installed";
}

// ---------------------------------------------------------------------------
// Pi: copy the self-contained bundled extension into ~/.pi/agent/extensions
// ---------------------------------------------------------------------------

function installPi(
  homeDir: string,
  extensionSource: string | undefined,
  log: (msg: string) => void
): InstallResult["status"] {
  // The bundled extension ships next to this module in dist/. In dev (running
  // from src/) there is no bundle — that resolves to a missing file and skips.
  const source =
    extensionSource ?? join(dirname(fileURLToPath(import.meta.url)), "inboxExtension.js");
  const dest = join(homeDir, ".pi", "agent", "extensions", "shepherd-inbox.js");

  if (existsSync(dest)) return "already-present";
  if (!existsSync(source)) {
    log(`[shepherd] bundled Pi extension not found at ${source} — skipping auto-install.`);
    return "skipped";
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(source, dest);
  return "installed";
}
