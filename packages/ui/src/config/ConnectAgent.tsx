import { useEffect, useId, useState } from "react";
import type { TokenSummaryT } from "@shepherd/shared";
import { useShepherdClient } from "../context.js";
import { describeError } from "../client.js";
import { formatRelative } from "../logic.js";

// ---------------------------------------------------------------------------
// ConnectAgent — "Connect your agent" Config section.
//
// Renders a tool picker and the copy-paste install command carrying the minted
// `shp_` token and the DIRECT Hub URL. Planning decision #2: the headless agent
// connects straight to the Hub's public URL (NOT the BFF), authenticated by the
// `shp_` bearer — only the browser/dashboard goes through the BFF. So the URL
// embedded here is `hubUrl` (the direct Hub URL), which is distinct from the
// dashboard client's baseUrl when hosted, and equal to it for self-host.
//
// The token minted here is ACCOUNT-scoped, not workspace-scoped: one token
// works across every workspace the caller belongs to, so there's no per-repo
// re-tokening and no hidden `shepherd link` step. The agent instead asks which
// workspace to coordinate a repo with the first time it opens that repo (the
// marker/first-run flow) — the install command never carries a workspace.
//
// Token lifecycle (contract MintTokenResponse): the raw token is returned ONCE
// at mint time — the hub stores only its hash and listAccountTokens never
// carries the secret. So we surface the raw value once, embed it in the
// command, and warn that it won't be shown again. listAccountTokens drives
// the management list (revoke).
// ---------------------------------------------------------------------------

export interface ConnectAgentProps {
  /**
   * The DIRECT Hub URL the agent connects to (public Cloud Run URL when hosted).
   * Defaults to the dashboard client's baseUrl, which is correct for self-host
   * where the agent and the dashboard share the Hub origin.
   */
  hubUrl?: string;
}

type Tool = "claude" | "codex" | "pi" | "cursor" | "generic";

const TOOLS: ReadonlyArray<{ id: Tool; label: string }> = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "pi", label: "Pi" },
  { id: "cursor", label: "Cursor" },
  { id: "generic", label: "Generic (JSON)" },
];

// The token placeholder shown before a real token is minted. Switching tools or
// reading the command pre-mint shows this, never a real secret.
const TOKEN_PLACEHOLDER = "shp_<paste-after-generating>";

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

interface HookSetup {
  /** Where the first-run auto-install writes. */
  target: string;
  /** The manual equivalent, shown as collapsed reference (null = a bundled file copy, nothing to paste). */
  snippet: string | null;
}

function hookSetup(tool: Tool): HookSetup | null {
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

// "created 3d ago · never used" / "created 3d ago · last used 2h ago" — helps
// an operator tell which tokens are still active before revoking one.
function tokenMeta(token: TokenSummaryT, nowMs: number): string {
  const created = `created ${formatRelative(token.createdAt, nowMs)}`;
  const used = token.lastUsedAt ? `last used ${formatRelative(token.lastUsedAt, nowMs)}` : "never used";
  return `${created} · ${used}`;
}

function installCommand(tool: Tool, hubUrl: string, token: string): string {
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

export function ConnectAgent({ hubUrl }: ConnectAgentProps) {
  const client = useShepherdClient();
  const directHubUrl = hubUrl ?? client.baseUrl;
  const headingId = useId();

  const [tool, setTool] = useState<Tool>("claude");
  const [name, setName] = useState("");
  // The raw token from the most recent mint — shown once, then only as command.
  const [rawToken, setRawToken] = useState<string | null>(null);
  const [tokens, setTokens] = useState<TokenSummaryT[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // True for a couple seconds after a successful copy, to flash the button label.
  const [copied, setCopied] = useState(false);
  // True until the first loadTokens() resolves, so the management list shows a
  // loading placeholder rather than the "No tokens yet." empty state.
  const [loading, setLoading] = useState(true);
  // Per-row in-flight revoke guard (by token id) to block double-submit.
  const [revokingId, setRevokingId] = useState<string | null>(null);

  async function loadTokens() {
    try {
      const res = await client.listAccountTokens();
      setTokens(res.tokens);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    void loadTokens();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  async function generate() {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const res = await client.mintAccountToken(
        name.trim() ? { name: name.trim() } : {},
      );
      setRawToken(res.token);
      setName("");
      await loadTokens();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(tokenId: string) {
    if (revokingId) return;
    setRevokingId(tokenId);
    setError(null);
    setStatus(null);
    try {
      await client.revokeAccountToken(tokenId);
      setTokens((prev) => prev.filter((t) => t.id !== tokenId));
      setStatus("Token revoked");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setRevokingId(null);
    }
  }

  const command = installCommand(tool, directHubUrl, rawToken ?? TOKEN_PLACEHOLDER);
  const hook = hookSetup(tool);

  async function copyCommand() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <section className="shepherd-connect-agent" aria-labelledby={headingId}>
      <div className="card-head">
        <h3 id={headingId}>Connect your agent</h3>
        <p className="card-sub">
          Generate a token; it works across all your workspaces, so paste the
          command into your coding tool.
        </p>
        <p className="card-sub">
          The first time the agent changes files in a repo, Shepherd asks
          which workspace to coordinate that repo with, once per repo,
          right in your tool.
        </p>
      </div>

      <div className="card-body">
        <div className="field">
          <label htmlFor="connect-tool">Tool</label>
          <select
            id="connect-tool"
            value={tool}
            onChange={(e) => setTool(e.target.value as Tool)}
          >
            {TOOLS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field generate">
          <label htmlFor="token-name">Token name (optional)</label>
          <div className="field__row">
            <input
              id="token-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) {
                  e.preventDefault();
                  void generate();
                }
              }}
              placeholder="e.g. laptop"
            />
            <button type="button" onClick={() => void generate()} disabled={busy}>
              Generate token
            </button>
          </div>
        </div>

        {error && <p role="alert">{error}</p>}
        {status && <p role="status">{status}</p>}

        {rawToken && (
          <p className="token-once" role="status">
            Copy this token now; it won&apos;t be shown again.
          </p>
        )}

        <div className="install-command">
          <pre data-testid="install-command">{command}</pre>
          <button
            type="button"
            className="install-command__copy"
            aria-label={copied ? "Copied" : "Copy command"}
            title={copied ? "Copied" : "Copy"}
            onClick={() => void copyCommand()}
          >
            {copied ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </button>
        </div>

        {hook && (
          <div className="hook-setup">
            <p className="card-sub">
              Message delivery sets itself up: the first time the agent runs,
              Shepherd adds its inbox hook to <code>{hook.target}</code>{" "}
              automatically. It delivers teammate announcements and reminds
              the agent to link each repo before its first write. This
              happens at most once; set{" "}
              <code>SHEPHERD_NO_AUTO_HOOKS=1</code> to opt out.
            </p>
            {hook.snippet && (
              <details className="hook-reference">
                <summary>What gets added (manual equivalent)</summary>
                <div className="install-command">
                  <pre data-testid="hook-snippet">{hook.snippet}</pre>
                </div>
              </details>
            )}
          </div>
        )}

        <h4>Existing tokens</h4>
        {loading ? (
          <p role="status">Loading…</p>
        ) : tokens.length === 0 ? (
          <p>No tokens yet.</p>
        ) : (
          <ul>
            {tokens.map((t) => {
              const name = t.name ?? t.id;
              return (
                <li key={t.id}>
                  <span>{name}</span>
                  <span className="token-meta">{tokenMeta(t, Date.now())}</span>
                  {t.revokedAt ? (
                    <span className="revoked">revoked</span>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Revoke token ${name}`}
                      onClick={() => void revoke(t.id)}
                      disabled={revokingId === t.id}
                    >
                      Revoke
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
