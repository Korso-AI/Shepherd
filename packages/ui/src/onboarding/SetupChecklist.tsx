import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { WorkspaceAgentT, WorkspaceSummaryT } from "@shepherd/shared";
import { useShepherdClient } from "../context.js";
import { describeError } from "../client.js";
import {
  type Tool,
  TOOLS,
  TOKEN_PLACEHOLDER,
  agentSetupPrompt,
  installCommand,
  installInstruction,
  installPrerequisite,
  hookSetup,
  parseTool,
} from "../config/connectCommand.js";
import { readStored, writeStored } from "../storage.js";

// ---------------------------------------------------------------------------
// SetupChecklist — the first-run guide panel.
//
// Two steps, checked off from REAL state (not local bookkeeping):
//   1. Create your workspace — an inline name form (stage "create"), or a
//      checked summary naming the workspace (stage "connect").
//   2. Connect your first agent — the tool picker + install command from
//      `connectCommand` (ONE source of truth shared with the Config tab's
//      ConnectAgent). Minting a token reveals the numbered next steps (run the
//      command, message your coding agent to link the repo, done) and a live
//      check-in indicator flips the step to "done" the moment the caller's
//      `agents` prop shows an agent, then a "Go to your board" dismissal so
//      the operator leaves on their own terms.
//
// The "See what Shepherd can do" value-prop cards are NOT a step: they stay
// hidden while the operator is setting up and slide in as a side rail once a
// token exists (or an agent has already checked in) — the natural idle moment.
// The "Skip for now" escape hatch renders only in the connect stage: with no
// workspace the stage derivation deliberately never hides ("never block"), so
// a create-stage skip would be a silent no-op.
//
// The panel does NOT poll: landscape agents arrive via the `agents` prop and
// the stage is decided by the caller (Dashboard) via `useSetupStage`. It only
// owns the two mutations it triggers itself: createWorkspace and
// mintAccountToken.
// ---------------------------------------------------------------------------

/**
 * The message the operator sends their coding agent to link the repo. Kept
 * tool-agnostic and imperative — the agent's MCP `link` tool auto-links when
 * the account has exactly one workspace, which is guaranteed during first-run.
 */
const LINK_MESSAGE = "Link this repo to Shepherd";

/** The hosted product docs — canonical for self-hosted embeds too. */
const DOCS_URL = "https://korsoai.com/docs";

/**
 * localStorage flag: an account token has been minted from this browser. The
 * raw token itself is deliberately never persisted — this only remembers that
 * the milestone happened, so the cards rail comes back when the guide is
 * reopened (account-scoped like the token, hence no workspace key).
 */
const TOKEN_MINTED_KEY = "shepherd.setup.tokenMinted";

/**
 * The four value-prop framings shown in the post-token side rail. Each `icon`
 * is the inner nodes of a 24-viewBox stroke glyph (decorative — the rail marks
 * them `aria-hidden`), rendered in a shared `<svg>` template.
 */
const FEATURES: ReadonlyArray<{
  title: string;
  body: string;
  icon: ReactNode;
}> = [
  {
    title: "See what your agents are doing",
    body: "Tasks show who is working where, so overlapping edits surface before they collide.",
    icon: (
      <>
        <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
  },
  {
    title: "Talk to your agents from anywhere",
    body: "Chat reaches every agent in the workspace, announcements land in their tools out-of-band.",
    icon: (
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    ),
  },
  {
    title: "Bring your team",
    body: "Your agents can talk to your teammates' agents, invite people by code or email and everyone coordinates in one workspace.",
    icon: (
      <>
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </>
    ),
  },
  {
    title: "Works with any harness",
    body: "Claude Code, Codex, Cursor, Pi, or a generic MCP client, one token connects them all.",
    icon: <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />,
  },
];

/** Props for {@link SetupChecklist}. */
export interface SetupChecklistProps {
  /** Which step is active: `"create"` (step 1) or `"connect"` (step 2). */
  stage: "create" | "connect";
  /** The active workspace, or `null` before one exists (stage `"create"`). */
  workspace: WorkspaceSummaryT | null;
  /**
   * Landscape agents from the caller's poll, or `null` before the first
   * snapshot lands. Empty/`null` keeps step 2 waiting; any agent checks it off.
   */
  agents: WorkspaceAgentT[] | null;
  /**
   * The DIRECT Hub URL the agent connects to; defaults to the dashboard
   * client's `baseUrl` (correct for self-host where they share an origin).
   */
  hubUrl?: string;
  /** Called after a successful workspace create so the shell re-lists. */
  onWorkspacesChanged?: () => void;
  /**
   * Called when the operator dismisses the guide ("Skip for now", or "Go to
   * your board" after the first agent checks in).
   */
  onSkip: () => void;
}

/** Pick the agent to name in the check-in indicator: a live one, else the first. */
function checkedInAgent(
  agents: WorkspaceAgentT[] | null,
): WorkspaceAgentT | null {
  if (!agents || agents.length === 0) return null;
  return agents.find((a) => a.presence === "live") ?? agents[0] ?? null;
}

/** A step heading with a completed check ("✓" + hidden text for AT). */
function StepHeading({ done, children }: { done: boolean; children: string }) {
  return (
    <h3>
      {done && (
        <span className="shepherd-setup__check" aria-hidden="true">
          ✓{" "}
        </span>
      )}
      {children}
      {done && <span className="shepherd-setup__sr"> (completed)</span>}
    </h3>
  );
}

export function SetupChecklist({
  stage,
  workspace,
  agents,
  hubUrl,
  onWorkspacesChanged,
  onSkip,
}: SetupChecklistProps) {
  const client = useShepherdClient();
  const directHubUrl = hubUrl ?? client.baseUrl;
  const nameFieldId = useId();

  // Step 1 (create) state. `created` stays true after a successful create so
  // the button cannot double-submit in the window before the caller's re-list
  // swaps the stage to "connect".
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Step 2 (connect) state.
  const [tool, setTool] = useState<Tool>("claude");
  const [rawToken, setRawToken] = useState<string | null>(null);
  // Whether a token was EVER minted from this browser (persisted milestone,
  // not the credential) — keeps the cards rail visible across guide reopens.
  const [everMinted, setEverMinted] = useState(
    () => readStored(TOKEN_MINTED_KEY) !== null,
  );
  const [minting, setMinting] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [copied, setCopied] = useState<
    "command" | "message" | "prereq" | "prompt" | null
  >(null);
  const [copyError, setCopyError] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const step1Done = stage === "connect";
  const agent = checkedInAgent(agents);
  const step2Done = agent !== null;

  // Focus management: when create succeeds and the stage flips to "connect",
  // move focus to step 2's heading so keyboard/SR users land on the next step
  // instead of being dumped at <body> when the create form unmounts.
  const step2HeadingRef = useRef<HTMLDivElement | null>(null);
  const prevStage = useRef(stage);
  useEffect(() => {
    if (prevStage.current === "create" && stage === "connect") {
      step2HeadingRef.current?.focus();
    }
    prevStage.current = stage;
  }, [stage]);

  // Once the agent has checked in, the raw token has done its job — drop it
  // from state (and the DOM) so a live bearer credential doesn't sit rendered
  // for the rest of the session.
  useEffect(() => {
    if (step2Done) setRawToken(null);
  }, [step2Done]);

  // Clear the "Copied" flash timer on unmount.
  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  // One action drives both steps: in the "create" stage a single click creates
  // the workspace and then mints the token; in the "connect" stage (a workspace
  // already exists) it just mints. Creating first, then minting, means the
  // operator never has to click twice — the token button lights up the moment a
  // name is typed. The account token is account-scoped, so minting only needs a
  // display label, which we take from the local name before the created
  // workspace propagates back through the `workspace` prop.
  async function setup() {
    if (creating || minting) return;
    const label = workspace?.name ?? name.trim();

    // Step 1 — create the workspace, but only while we're still in the create
    // stage and haven't already created one (the `created` latch guards the
    // window before the caller's re-list swaps the stage to "connect", so a
    // second click retries the mint without creating a duplicate workspace).
    if (stage === "create" && !created) {
      if (!name.trim()) return;
      setCreating(true);
      setCreateError(null);
      try {
        await client.createWorkspace({ name: name.trim() });
        setCreated(true);
        onWorkspacesChanged?.();
      } catch (err) {
        setCreateError(describeError(err));
        return; // Create failed — do not mint against a workspace that isn't there.
      } finally {
        setCreating(false);
      }
    }

    // Step 2 — mint the account token.
    setMinting(true);
    setTokenError(null);
    try {
      const res = await client.mintAccountToken({ name: `${label} agent` });
      setRawToken(res.token);
      setEverMinted(true);
      writeStored(TOKEN_MINTED_KEY, "1");
    } catch (err) {
      setTokenError(describeError(err));
    } finally {
      setMinting(false);
    }
  }

  const command = installCommand(
    tool,
    directHubUrl,
    rawToken ?? TOKEN_PLACEHOLDER,
  );
  const prereq = installPrerequisite(tool);
  const hook = hookSetup(tool);

  // The cards rail appears once a token exists — and stays: across the agent
  // check-in (the token is scrubbed then, but the rail must not vanish with
  // it) and across guide reopens (the persisted `everMinted` milestone).
  const showRail = rawToken !== null || step2Done || everMinted;

  // Was the rail already earned when the panel mounted (reopening the guide
  // after the first token)? Then the whole panel pops in as ONE animation —
  // the staggered rail entrance is the first-mint reward, not a recurring
  // transition every time the guide reopens.
  const [railAtMount] = useState(showRail);

  async function copyText(
    text: string,
    what: "command" | "message" | "prereq" | "prompt",
  ) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setCopyError(false);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard permission denied / insecure context: never lose a one-time
      // token silently — tell the operator to select the text themselves.
      setCopyError(true);
    }
  }

  return (
    <section
      className={
        "shepherd-setup" +
        (showRail ? " shepherd-setup--rail" : "") +
        (showRail && railAtMount ? " shepherd-setup--pop" : "")
      }
      aria-label="Setup guide"
    >
      <div className="shepherd-setup__main">
        {/* Step 1 — Create your workspace. */}
        <div
          className={
            "shepherd-setup__step" +
            (step1Done ? " shepherd-setup__step--done" : "")
          }
          aria-current={stage === "create" ? "step" : undefined}
        >
          <div className="card-head">
            <StepHeading done={step1Done}>Create your workspace</StepHeading>
            <p className="card-sub">
              A workspace is the shared space your agents and teammates
              coordinate in.
            </p>
          </div>
          <div className="card-body">
            {step1Done && workspace ? (
              <p role="status">{workspace.name}</p>
            ) : (
              <form
                className="field"
                onSubmit={(e) => {
                  e.preventDefault();
                  void setup();
                }}
              >
                <label htmlFor={nameFieldId}>Workspace name</label>
                <div className="field__row">
                  <input
                    id={nameFieldId}
                    type="text"
                    value={name}
                    placeholder="e.g. Acme Engineering"
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                {createError && <p role="alert">{createError}</p>}
              </form>
            )}
          </div>
        </div>

        {/* Step 2 — Connect your first agent. `--armed` lifts the future-step
          muting the moment a name makes the one-click button actionable, so
          an enabled Generate token never LOOKS disabled. */}
        <div
          className={
            "shepherd-setup__step" +
            (step2Done ? " shepherd-setup__step--done" : "") +
            (stage === "create" && name.trim()
              ? " shepherd-setup__step--armed"
              : "")
          }
          aria-current={stage === "connect" && !step2Done ? "step" : undefined}
        >
          <div className="card-head" ref={step2HeadingRef} tabIndex={-1}>
            <StepHeading done={step2Done}>Connect your first agent</StepHeading>
            <p className="card-sub">
              Generate a token and paste the command into your coding tool. It
              works across every workspace you belong to.
            </p>
          </div>
          <div className="card-body shepherd-connect-agent">
            <div className="field">
              <label htmlFor={`${nameFieldId}-tool`}>Tool</label>
              <select
                id={`${nameFieldId}-tool`}
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

            <button
              type="button"
              onClick={() => void setup()}
              disabled={
                creating || minting || (stage === "create" && !name.trim())
              }
            >
              {creating
                ? "Creating…"
                : minting
                  ? "Generating…"
                  : "Generate token"}
            </button>
            {stage === "create" && !name.trim() && (
              <p className="card-sub">Name your workspace above to continue.</p>
            )}

            {tokenError && <p role="alert">{tokenError}</p>}

            {rawToken && (
              <p className="token-once" role="status">
                This contains your token — copy it now; the token won&apos;t be
                shown again.
              </p>
            )}

            {/* JSON-config tools: the npm install can't ride inside the JSON
              block, so it gets its own copyable box above it. */}
            {prereq && (
              <div className="install-command">
                <pre data-testid="setup-install-prereq">{prereq}</pre>
                <button
                  type="button"
                  className="install-command__copy shepherd-setup__copy"
                  aria-label={
                    copied === "prereq" ? "Copied" : "Copy install command"
                  }
                  title={copied === "prereq" ? "Copied" : "Copy"}
                  onClick={() => void copyText(prereq, "prereq")}
                >
                  {copied === "prereq" ? "Copied" : "Copy"}
                </button>
              </div>
            )}

            <div className="install-command">
              {/* `ph-no-capture` / `data-sensitive`: the command can carry a live
                bearer token; session-replay tools the HOST runs (PostHog,
                FullStory…) honor these hints and redact the block. */}
              <pre
                data-testid="setup-install-command"
                className="ph-no-capture"
                data-sensitive="true"
              >
                {command}
              </pre>
              <button
                type="button"
                className="install-command__copy shepherd-setup__copy"
                aria-label={copied === "command" ? "Copied" : "Copy command"}
                title={copied === "command" ? "Copied" : "Copy"}
                onClick={() => void copyText(command, "command")}
              >
                {copied === "command" ? "Copied" : "Copy"}
              </button>
            </div>
            {/* Announce copy feedback for AT: a label swap on the focused button
              is not reliably read out, a live region is. */}
            <span className="shepherd-setup__sr" role="status">
              {copied === "command" || copied === "prereq"
                ? "Command copied to clipboard"
                : copied === "message"
                  ? "Message copied to clipboard"
                  : copied === "prompt"
                    ? "Prompt copied to clipboard"
                    : ""}
            </span>
            {copyError && (
              <p role="alert">
                Copy failed — select the command above and copy it manually.
              </p>
            )}

            {/* Hands-off alternative: a prompt the operator pastes into their
              coding agent so IT runs the setup above. Gated on the live token
              (the prompt embeds it — pre-mint it would carry the placeholder
              and configure a broken connection) and copied without ever being
              rendered, so the token isn't displayed a second time. */}
            {rawToken && (
              <div className="shepherd-setup__agent">
                <button
                  type="button"
                  className="shepherd-setup__agent-btn"
                  onClick={() =>
                    void copyText(
                      agentSetupPrompt(tool, directHubUrl, rawToken),
                      "prompt",
                    )
                  }
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
                  </svg>
                  {copied === "prompt" ? "Prompt copied!" : "Set up by agent"}
                </button>
                <p className="card-sub">
                  Copies a prompt that has your coding agent do the setup for
                  you.
                </p>
              </div>
            )}

            {/* Post-token next steps: the concrete do-this-now sequence. Renders
              while the raw token is live (it scrubs on first check-in, at which
              point the checked-in state below takes over as the guidance). */}
            {rawToken && (
              <ol className="shepherd-setup__next">
                <li>{installInstruction(tool)}</li>
                <li>
                  Open your coding agent in the repo you want coordinated and
                  send it this message:
                  <div className="install-command">
                    <pre data-testid="setup-link-message">{LINK_MESSAGE}</pre>
                    <button
                      type="button"
                      className="install-command__copy shepherd-setup__copy"
                      aria-label={
                        copied === "message" ? "Copied" : "Copy message"
                      }
                      title={copied === "message" ? "Copied" : "Copy"}
                      onClick={() => void copyText(LINK_MESSAGE, "message")}
                    >
                      {copied === "message" ? "Copied" : "Copy"}
                    </button>
                  </div>
                </li>
                <li>
                  <strong>Nothing else to do!</strong> Your agents will use this
                  space to coordinate.
                </li>
              </ol>
            )}

            {hook && (
              <div className="hook-setup">
                <p className="card-sub">
                  Message delivery sets itself up: the first time the agent
                  runs, Shepherd adds its inbox hook to{" "}
                  <code>{hook.target}</code>.
                </p>
                {hook.snippet && (
                  <details className="hook-reference">
                    <summary>What gets added (manual equivalent)</summary>
                    <div className="install-command">
                      <pre data-testid="setup-hook-snippet">{hook.snippet}</pre>
                    </div>
                  </details>
                )}
              </div>
            )}

            {step2Done && agent ? (
              <>
                <p role="status">
                  {agent.name} checked in. You&apos;re all set.
                </p>
                <button
                  type="button"
                  className="shepherd-setup__done-cta"
                  onClick={onSkip}
                >
                  Go to your board
                </button>
              </>
            ) : (
              <p role="status">Waiting for your agent to check in…</p>
            )}
          </div>
        </div>

        {/* No skip in the create stage: with no workspace the stage derivation
          never hides ("never block"), so the button would be a silent no-op
          there. */}
        {stage === "connect" && (
          <button
            type="button"
            className="shepherd-setup__skip"
            onClick={onSkip}
          >
            Skip for now
          </button>
        )}
      </div>

      {/* See what Shepherd can do — informational value-prop cards, never
          dimmed (`--info` exempts it from the muting). Hidden during setup;
          slides in as a side rail once the token exists (the idle moment while
          waiting for the first check-in). */}
      {showRail && (
        <aside
          className="shepherd-setup__rail"
          aria-label="See what Shepherd can do"
        >
          <h3 className="shepherd-setup__rail-head">
            See what Shepherd can do
          </h3>
          <ul className="shepherd-setup__features">
            {FEATURES.map((f) => (
              <li className="shepherd-setup__feature" key={f.title}>
                <span
                  className="shepherd-setup__feature-icon"
                  aria-hidden="true"
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    {f.icon}
                  </svg>
                </span>
                <div className="shepherd-setup__feature-copy">
                  <h4>{f.title}</h4>
                  <p>{f.body}</p>
                </div>
              </li>
            ))}
          </ul>
          <a
            className="shepherd-setup__docs-link"
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer"
          >
            Read the docs <span aria-hidden="true">↗</span>
          </a>
        </aside>
      )}
    </section>
  );
}
