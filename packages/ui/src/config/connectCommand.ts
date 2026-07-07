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
            SessionStart: [
              { hooks: [{ type: "command", command: HOOK_COMMAND }] },
            ],
            PreToolUse: [
              {
                matcher: "*",
                hooks: [{ type: "command", command: HOOK_COMMAND }],
              },
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

/**
 * One-line "what to do with the command" instruction for a tool, shown as the
 * first post-token next step. CLI tools run the command; JSON-config tools
 * save the block into their MCP config file (paths per the comment on
 * {@link installCommand}'s CLI_PREFIX).
 */
export function installInstruction(tool: Tool): string {
  if (tool === "claude" || tool === "codex") {
    return "Run the commands above in your terminal.";
  }
  if (tool === "pi") {
    return "Run the install command in your terminal, then save the block to ~/.pi/agent/mcp.json (or .pi/mcp.json in the repo).";
  }
  if (tool === "cursor") {
    return "Run the install command in your terminal, then save the block to ~/.cursor/mcp.json (or .cursor/mcp.json in the repo).";
  }
  return "Run the install command in your terminal, then add the block to your MCP client's config.";
}

// Everything points at the globally-installed `shepherd-mcp` bin: `mcp add`
// mis-parses flags after its `--` separator, and a JSON config that shells out
// through `npx -y` re-resolves the package on every agent start. One global
// install, one bare bin everywhere.
const INSTALL_PACKAGE = "npm install -g @korso/shepherd";

/**
 * The install command a tool needs BEFORE {@link installCommand}'s output can
 * work, or `null` when the command string already embeds it (CLI tools, whose
 * two-line output starts with the install). JSON-config tools get it here as a
 * separate command — a shell line can't ride inside their JSON block.
 */
export function installPrerequisite(tool: Tool): string | null {
  return tool === "claude" || tool === "codex" ? null : INSTALL_PACKAGE;
}

// Where each JSON-config tool keeps its MCP config, phrased for the agent
// prompt ({@link agentSetupPrompt}); mirrors {@link installInstruction}.
const JSON_CONFIG_TARGET: Record<"pi" | "cursor" | "generic", string> = {
  pi: "~/.pi/agent/mcp.json (or .pi/mcp.json in this repo)",
  cursor: "~/.cursor/mcp.json (or .cursor/mcp.json in this repo)",
  generic: "my MCP client's config",
};

/**
 * A ready-to-paste prompt asking the operator's CODING AGENT to do the setup
 * itself — the hands-off alternative to running {@link installCommand} by
 * hand. Carries the same shell-safety guarantees (hostile hub URL / token
 * degrade to placeholders). The prompt embeds the live token, so callers only
 * offer it while a real minted token is in hand, and copy it to the clipboard
 * without rendering it.
 */
export function agentSetupPrompt(
  tool: Tool,
  rawHubUrl: string,
  rawTokenValue: string,
): string {
  const command = installCommand(tool, rawHubUrl, rawTokenValue);
  const intro =
    "Set up Shepherd, the MCP server my team uses to coordinate coding agents.";
  const finish =
    "When you're done, tell me to restart this session so the Shepherd MCP " +
    "server loads. After the restart I'll ask you to link this repo to Shepherd.";
  if (tool === "claude" || tool === "codex") {
    // `command` is the two-line install + `mcp add` pair.
    return [
      `${intro} Run these two commands and check they exit cleanly:`,
      "",
      command,
      "",
      finish,
    ].join("\n");
  }
  const prereq = installPrerequisite(tool);
  return [
    intro,
    "",
    `1. Run: ${prereq}`,
    `2. Merge the following into ${JSON_CONFIG_TARGET[tool]} — create the file if it doesn't exist, and keep any existing servers:`,
    "",
    command,
    "",
    finish,
  ].join("\n");
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
 * the minted `shp_` token. CLI tools (Claude, Codex) get TWO newline-joined
 * commands — a global `npm install`, then the `mcp add` pointing at the
 * installed bin; JSON-config tools (Pi, Cursor, generic) get an `mcpServers`
 * JSON block. Values that could break out of the command (see
 * {@link SHELL_SAFE}) are replaced with placeholders, never emitted raw.
 */
export function installCommand(
  tool: Tool,
  rawHubUrl: string,
  rawTokenValue: string,
): string {
  const hubUrl = safeHubUrl(rawHubUrl);
  const token = safeToken(rawTokenValue);
  if (tool === "generic" || tool === "pi" || tool === "cursor") {
    // PROGRAM names the tool in the presence feed; it defaults to
    // `claude-code`, so JSON-config tools set it explicitly.
    const env: Record<string, string> = {
      HUB_URL: hubUrl,
      SHEPHERD_TOKEN: token,
    };
    if (tool !== "generic") env["PROGRAM"] = tool;
    // The bin from the npm-install prerequisite ({@link installPrerequisite}).
    return JSON.stringify(
      {
        mcpServers: {
          shepherd: {
            command: "shepherd-mcp",
            args: [],
            env,
          },
        },
      },
      null,
      2,
    );
  }
  // Two commands, one per line (a multi-line paste runs them in sequence in
  // any terminal). Splitting keeps everything after the `--` separator down to
  // the bare installed bin: both `claude mcp add` and `codex mcp add` mis-parse
  // flags after `--` (e.g. "error: unknown option '-s'" on npx's `-p`), so an
  // inline `npx -y --package=…` there is exactly the syntax-error zone. Each
  // line is continuation-free (`\`/backtick/`^`) so it pastes cleanly anywhere.
  const envFlag = ENV_FLAG[tool];
  const parts = [
    CLI_PREFIX[tool],
    `${envFlag} HUB_URL=${hubUrl}`,
    `${envFlag} SHEPHERD_TOKEN=${token}`,
  ];
  // PROGRAM defaults to claude-code, so only non-Claude tools set it.
  if (tool === "codex") parts.push(`${envFlag} PROGRAM=codex`);
  parts.push("-- shepherd-mcp");
  return [INSTALL_PACKAGE, parts.join(" ")].join("\n");
}
