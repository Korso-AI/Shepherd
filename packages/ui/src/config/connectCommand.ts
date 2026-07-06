// ---------------------------------------------------------------------------
// connectCommand — the pure, stateless connect-agent pieces.
//
// The copy-paste install command (carrying the DIRECT Hub URL and the minted
// `shp_` token) and the message-delivery hook setup live here so the dashboard's
// `ConnectAgent` section and the onboarding checklist share ONE source of truth
// and cannot drift. Nothing here holds state, reads a secret, or touches the
// network — callers pass the hub URL and token in.
// ---------------------------------------------------------------------------

/** A coding tool the agent connects through. */
export type Tool = "claude" | "codex" | "pi" | "cursor" | "generic";

/** The pickable tools, in display order (id + human label). */
export const TOOLS: ReadonlyArray<{ id: Tool; label: string }> = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "pi", label: "Pi" },
  { id: "cursor", label: "Cursor" },
  { id: "generic", label: "Generic (JSON)" },
];

/**
 * The token placeholder shown before a real token is minted. Switching tools or
 * reading the command pre-mint shows this, never a real secret.
 */
export const TOKEN_PLACEHOLDER = "shp_<paste-after-generating>";

/**
 * Narrow a raw string (a `<select>` value, a query param…) to a {@link Tool},
 * falling back to `"claude"` for anything unrecognized. Lives beside the
 * {@link TOOLS} table it validates against so the one place a DOM string enters
 * the `Tool` union can't drift from the pickable set (per the repo's
 * no-raw-casts-at-boundaries rule).
 */
export function parseTool(value: string): Tool {
  const match = TOOLS.find((t) => t.id === value);
  return match ? match.id : "claude";
}

// Tools with an `mcp add` CLI. Pi, Cursor, and generic get a JSON config
// block instead: Pi reads `~/.pi/agent/mcp.json` (or `.pi/mcp.json`), Cursor
// reads `~/.cursor/mcp.json` (or `.cursor/mcp.json`) — same `mcpServers` shape.
const CLI_PREFIX: Record<"claude" | "codex", string> = {
  claude: "claude mcp add shepherd -s user",
  codex: "codex mcp add shepherd",
};

// `claude mcp add` takes `-e KEY=val`; `codex mcp add` only accepts `--env`.
const ENV_FLAG: Record<"claude" | "codex", string> = {
  claude: "-e",
  codex: "--env",
};

// The shepherd-inbox-hook bin: delivers teammate announcements out-of-band AND
// nudges the agent to run `link` before its first write in an unlinked repo.
// The MCP server installs this ITSELF the first time the agent runs (once per
// machine, additive-only, `SHEPHERD_NO_AUTO_HOOKS=1` to opt out) — Claude,
// Codex, and Cursor get their config merged, Pi gets the bundled extension
// file copied in. So the dashboard's job is to SAY that, name where the write
// lands, and keep the manual equivalent as a collapsed reference for users who
// opted out or want to audit the change.
const HOOK_COMMAND = "npx -y --package=@korso/shepherd shepherd-inbox-hook";

/** Where and how the message-delivery hook is set up for a tool. */
export interface HookSetup {
  /** Where the first-run auto-install writes. */
  target: string;
  /** The manual equivalent, shown as collapsed reference (null = a bundled file copy, nothing to paste). */
  snippet: string | null;
}

/**
 * The message-delivery hook setup for a tool, or `null` for tools with no hook
 * integration (generic). The `target` names where the first-run auto-install
 * writes; `snippet` is the manual equivalent, or `null` when the auto-install
 * copies a bundled file (nothing to paste).
 */
export function hookSetup(tool: Tool): HookSetup | null {
  if (tool === "claude") {
    // SessionStart front-loads the link ask; PreToolUse delivers announcements
    // and re-nudges right before a write in a still-unlinked repo.
    return {
      target: "~/.claude/settings.json",
      snippet: JSON.stringify(
        {
          hooks: {
            SessionStart: [{ hooks: [{ type: "command", command: HOOK_COMMAND }] }],
            PreToolUse: [
              { matcher: "*", hooks: [{ type: "command", command: HOOK_COMMAND }] },
            ],
          },
        },
        null,
        2,
      ),
    };
  }
  if (tool === "codex") {
    // Codex's PreToolUse only fires for Bash, so UserPromptSubmit is the
    // frequent event there; hooks must be feature-flagged on.
    return {
      target: "~/.codex/config.toml",
      snippet: [
        "[features]",
        "hooks = true",
        "",
        "[[hooks.UserPromptSubmit]]",
        'command = ["npx", "-y", "--package=@korso/shepherd", "shepherd-inbox-hook"]',
      ].join("\n"),
    };
  }
  if (tool === "pi") {
    // Pi delivery is a bundled extension FILE, not a config edit — the
    // auto-install copies it into place; there is nothing to paste manually.
    return {
      target: "~/.pi/agent/extensions/shepherd-inbox.js",
      snippet: null,
    };
  }
  if (tool === "cursor") {
    // Only beforeSubmitPrompt is wired: it is the one Cursor event verified
    // (spike, Cursor 3.9.16) to inject the hook's output into model context.
    return {
      target: "~/.cursor/hooks.json",
      snippet: JSON.stringify(
        {
          version: 1,
          hooks: {
            beforeSubmitPrompt: [{ command: HOOK_COMMAND }],
          },
        },
        null,
        2,
      ),
    };
  }
  return null;
}

// The CLI commands embed values UNQUOTED (quoting is shell-specific; the
// command must paste cleanly into bash, zsh, PowerShell, and cmd), so anything
// interpolated must be inert in all of them. A well-formed http(s) URL with no
// query/fragment and a minted `shp_` token both fit this charset; anything
// else (a misconfigured or compromised `hubUrl` prop carrying spaces, `;`,
// `$(…)`, backticks…) is replaced with a self-describing placeholder rather
// than pasted into the operator's terminal.
const SHELL_SAFE = /^[A-Za-z0-9._:/%-]+$/;

/** `hubUrl` if it is a shell-inert http(s) URL, else a fill-in placeholder. */
function safeHubUrl(hubUrl: string): string {
  try {
    const parsed = new URL(hubUrl);
    if (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      SHELL_SAFE.test(hubUrl)
    ) {
      return hubUrl;
    }
  } catch {
    // Not a URL at all — fall through to the placeholder.
  }
  return "<your-hub-url>";
}

/** `token` if it looks like a minted `shp_` token (shell-inert), else the placeholder. */
function safeToken(token: string): string {
  if (token === TOKEN_PLACEHOLDER) return token;
  return /^shp_[A-Za-z0-9._-]+$/.test(token) ? token : TOKEN_PLACEHOLDER;
}

/**
 * The copy-paste install command for a tool, carrying the DIRECT Hub URL and
 * the minted `shp_` token. CLI tools (Claude, Codex) get a single-line
 * `mcp add` command; JSON-config tools (Pi, Cursor, generic) get an
 * `mcpServers` JSON block. Values that could break out of the command (see
 * {@link SHELL_SAFE}) are replaced with placeholders, never emitted raw.
 */
export function installCommand(tool: Tool, rawHubUrl: string, rawTokenValue: string): string {
  const hubUrl = safeHubUrl(rawHubUrl);
  const token = safeToken(rawTokenValue);
  if (tool === "generic" || tool === "pi" || tool === "cursor") {
    // PROGRAM names the tool in the presence feed; it defaults to
    // `claude-code`, so JSON-config tools set it explicitly.
    const env: Record<string, string> = { HUB_URL: hubUrl, SHEPHERD_TOKEN: token };
    if (tool !== "generic") env["PROGRAM"] = tool;
    return JSON.stringify(
      {
        mcpServers: {
          shepherd: {
            command: "npx",
            args: ["-y", "--package=@korso/shepherd", "shepherd-mcp"],
            env,
          },
        },
      },
      null,
      2,
    );
  }
  // A single line with no shell-specific continuation character (`\` in
  // bash/zsh, backtick in PowerShell, `^` in cmd) so the command pastes
  // cleanly into any terminal.
  const envFlag = ENV_FLAG[tool];
  const parts = [
    CLI_PREFIX[tool],
    `${envFlag} HUB_URL=${hubUrl}`,
    `${envFlag} SHEPHERD_TOKEN=${token}`,
  ];
  // PROGRAM defaults to claude-code, so only non-Claude tools set it.
  if (tool === "codex") parts.push(`${envFlag} PROGRAM=codex`);
  // NOTE: long `--package=` form on purpose — `claude mcp add` (CLI) fails to
  // parse a bare `-p` after the `--` separator ("error: unknown option '-s'").
  parts.push("-- npx -y --package=@korso/shepherd shepherd-mcp");
  return parts.join(" ");
}
