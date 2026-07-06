import { useEffect, useId, useRef, useState } from "react";
import type { TokenSummaryT } from "@shepherd/shared";
import { useShepherdClient } from "../context.js";
import { describeError } from "../client.js";
import { formatRelative } from "../logic.js";
import {
  type Tool,
  TOOLS,
  TOKEN_PLACEHOLDER,
  installCommand,
  hookSetup,
  parseTool,
} from "./connectCommand.js";

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

// "created 3d ago · never used" / "created 3d ago · last used 2h ago" — helps
// an operator tell which tokens are still active before revoking one.
function tokenMeta(token: TokenSummaryT, nowMs: number): string {
  const created = `created ${formatRelative(token.createdAt, nowMs)}`;
  const used = token.lastUsedAt ? `last used ${formatRelative(token.lastUsedAt, nowMs)}` : "never used";
  return `${created} · ${used}`;
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
  const [copyError, setCopyError] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setCopyError(false);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission denied / insecure context: never lose a one-time
      // token silently — tell the operator to select the text themselves.
      setCopyError(true);
    }
  }

  // Clear the "Copied" flash timer on unmount.
  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

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
            onChange={(e) => setTool(parseTool(e.target.value))}
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
        {copyError && (
          <p role="alert">
            Copy failed — select the command below and copy it manually.
          </p>
        )}

        {rawToken && (
          <p className="token-once" role="status">
            Copy this token now; it won&apos;t be shown again.
          </p>
        )}

        <div className="install-command">
          {/* `ph-no-capture` / `data-sensitive`: the command can carry a live
              bearer token; session-replay tools the HOST runs honor these
              hints and redact the block. */}
          <pre data-testid="install-command" className="ph-no-capture" data-sensitive="true">
            {command}
          </pre>
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
              // An unnamed token gets a human fallback + a short id suffix to
              // tell twins apart — NEVER the raw uuid alone, which reads like a
              // secret and confuses the "paste your token" flow.
              const name = t.name ?? `Unnamed token (${t.id.slice(0, 8)})`;
              return (
                <li key={t.id}>
                  <span className={t.name ? undefined : "token-unnamed"}>{name}</span>
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
