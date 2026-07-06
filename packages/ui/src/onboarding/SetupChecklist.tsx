import { useEffect, useId, useRef, useState } from "react";
import type { WorkspaceAgentT, WorkspaceSummaryT } from "@shepherd/shared";
import { useShepherdClient } from "../context.js";
import { describeError } from "../client.js";
import {
  type Tool,
  TOOLS,
  TOKEN_PLACEHOLDER,
  installCommand,
  hookSetup,
  parseTool,
} from "../config/connectCommand.js";

// ---------------------------------------------------------------------------
// SetupChecklist — the first-run guide panel.
//
// Three steps, checked off from REAL state (not local bookkeeping):
//   1. Create your workspace — an inline create form (stage "create"), or a
//      checked summary naming the workspace (stage "connect").
//   2. Connect your first agent — the tool picker + install command from
//      `connectCommand` (ONE source of truth shared with the Config tab's
//      ConnectAgent), a live check-in indicator that flips the step to "done"
//      the moment the caller's `agents` prop shows an agent, then a "Go to
//      your board" dismissal so the operator leaves on their own terms.
//   3. See what Shepherd can do — static value-prop cards. The "Skip for now"
//      escape hatch renders only in the connect stage: with no workspace the
//      stage derivation deliberately never hides ("never block"), so a create-
//      stage skip would be a silent no-op.
//
// The panel does NOT poll: landscape agents arrive via the `agents` prop and
// the stage is decided by the caller (Dashboard) via `useSetupStage`. It only
// owns the two mutations it triggers itself: createWorkspace and
// mintAccountToken.
// ---------------------------------------------------------------------------

/** The four value-prop framings shown in step 3. */
const FEATURES: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "See what your agents are doing",
    body: "Tasks show who is working where, so overlapping edits surface before they collide.",
  },
  {
    title: "Talk to your agents from anywhere",
    body: "Chat reaches every agent in the workspace — announcements land in their tools out-of-band.",
  },
  {
    title: "Bring your team",
    body: "Invite teammates by code or email; everyone shares one coordinated workspace.",
  },
  {
    title: "Works with any harness",
    body: "Claude Code, Codex, Cursor, Pi, or a generic MCP client — one token connects them all.",
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
function checkedInAgent(agents: WorkspaceAgentT[] | null): WorkspaceAgentT | null {
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
  const [minting, setMinting] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
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

  async function create() {
    if (!name.trim() || creating || created) return;
    setCreating(true);
    setCreateError(null);
    try {
      await client.createWorkspace({ name: name.trim() });
      setCreated(true);
      onWorkspacesChanged?.();
    } catch (err) {
      setCreateError(describeError(err));
    } finally {
      setCreating(false);
    }
  }

  async function generate() {
    if (minting) return;
    setMinting(true);
    setTokenError(null);
    try {
      const res = await client.mintAccountToken({
        name: `${workspace?.name ?? "workspace"} agent`,
      });
      setRawToken(res.token);
    } catch (err) {
      setTokenError(describeError(err));
    } finally {
      setMinting(false);
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

  return (
    <section className="shepherd-setup" aria-label="Setup guide">
      {/* Step 1 — Create your workspace. */}
      <div
        className={"shepherd-setup__step" + (step1Done ? " shepherd-setup__step--done" : "")}
        aria-current={stage === "create" ? "step" : undefined}
      >
        <div className="card-head">
          <StepHeading done={step1Done}>Create your workspace</StepHeading>
          <p className="card-sub">
            A workspace is the shared space your agents and teammates coordinate in.
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
                void create();
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
                <button type="submit" disabled={creating || created || !name.trim()}>
                  {creating ? "Creating…" : "Create workspace"}
                </button>
              </div>
              {createError && <p role="alert">{createError}</p>}
            </form>
          )}
        </div>
      </div>

      {/* Step 2 — Connect your first agent. */}
      <div
        className={"shepherd-setup__step" + (step2Done ? " shepherd-setup__step--done" : "")}
        aria-current={stage === "connect" && !step2Done ? "step" : undefined}
      >
        <div className="card-head" ref={step2HeadingRef} tabIndex={-1}>
          <StepHeading done={step2Done}>Connect your first agent</StepHeading>
          <p className="card-sub">
            Generate a token and paste the command into your coding tool. It works
            across every workspace you belong to.
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
            onClick={() => void generate()}
            disabled={minting || stage !== "connect"}
          >
            {minting ? "Generating…" : "Generate token"}
          </button>
          {stage !== "connect" && (
            <p className="card-sub">Create a workspace first (step 1).</p>
          )}

          {tokenError && <p role="alert">{tokenError}</p>}

          {rawToken && (
            <p className="token-once" role="status">
              This command contains your token — copy it now; the token won&apos;t
              be shown again.
            </p>
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
              className="install-command__copy"
              aria-label={copied ? "Copied" : "Copy command"}
              title={copied ? "Copied" : "Copy"}
              onClick={() => void copyCommand()}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          {/* Announce copy feedback for AT: a label swap on the focused button
              is not reliably read out, a live region is. */}
          <span className="shepherd-setup__sr" role="status">
            {copied ? "Command copied to clipboard" : ""}
          </span>
          {copyError && (
            <p role="alert">
              Copy failed — select the command above and copy it manually.
            </p>
          )}

          {hook && (
            <div className="hook-setup">
              <p className="card-sub">
                Message delivery sets itself up: the first time the agent runs,
                Shepherd adds its inbox hook to <code>{hook.target}</code>.
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
              <p role="status">{agent.name} checked in. You&apos;re all set.</p>
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

      {/* Step 3 — See what Shepherd can do. Informational, not a sequential
          step — never dimmed (`--info` exempts it from the muting). */}
      <div className="shepherd-setup__step shepherd-setup__step--info">
        <div className="card-head">
          <h3>See what Shepherd can do</h3>
        </div>
        <div className="card-body">
          <div className="shepherd-setup__cards">
            {FEATURES.map((f) => (
              <div className="card" key={f.title}>
                <h4>{f.title}</h4>
                <p className="card-sub">{f.body}</p>
              </div>
            ))}
          </div>
          {/* No skip in the create stage: with no workspace the stage
              derivation never hides ("never block"), so the button would be a
              silent no-op there. */}
          {stage === "connect" && (
            <button type="button" className="shepherd-setup__skip" onClick={onSkip}>
              Skip for now
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
