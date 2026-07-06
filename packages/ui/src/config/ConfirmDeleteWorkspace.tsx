import { useEffect, useId, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// ConfirmDeleteWorkspace — the type-the-name confirmation modal guarding the
// irreversible "Delete workspace" action.
//
// Deleting a workspace wipes agents, sessions, tasks, announcements, change
// history, tokens, invites, and memberships. A plain "Are you sure?" is too weak
// a guard for that blast radius, so the Delete button stays disabled until the
// operator types the workspace's exact name (the GitHub-style pattern). This is
// the codebase's first true modal (FeedbackWidget is an inline popover): it
// renders a backdrop + role="dialog", traps initial focus on the input, and
// closes on Escape or a backdrop click (never while a delete is in flight).
// ---------------------------------------------------------------------------

export interface ConfirmDeleteWorkspaceProps {
  /** The workspace name the operator must type verbatim to enable Delete. */
  workspaceName: string;
  /** True while the delete request is in flight — disables the controls. */
  busy: boolean;
  /** A failed-delete message to show inline, or null. */
  error: string | null;
  /** Fired when the confirmed Delete button is pressed. */
  onConfirm: () => void;
  /** Fired on Cancel / Escape / backdrop click (ignored while busy). */
  onCancel: () => void;
}

export function ConfirmDeleteWorkspace({
  workspaceName,
  busy,
  error,
  onConfirm,
  onCancel,
}: ConfirmDeleteWorkspaceProps) {
  const headingId = useId();
  const descId = useId();
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the confirmation input when the modal opens.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Escape cancels (unless a delete is in flight).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  const confirmed = typed === workspaceName;

  return (
    <div
      className="shepherd-modal__backdrop"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        className="shepherd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={descId}
        // Clicks inside the dialog must not bubble to the backdrop's cancel.
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={headingId}>Delete workspace</h3>
        <p id={descId} className="shepherd-modal__body">
          This permanently deletes <b>{workspaceName}</b> and all of its data:
          agents, sessions, tasks, announcements, change history, tokens, invites,
          and members. This cannot be undone.
        </p>

        <label htmlFor={`${headingId}-input`} className="shepherd-modal__label">
          Type <b>{workspaceName}</b> to confirm
        </label>
        <input
          id={`${headingId}-input`}
          ref={inputRef}
          type="text"
          value={typed}
          autoComplete="off"
          disabled={busy}
          onChange={(e) => setTyped(e.target.value)}
        />

        {error && <p role="alert">{error}</p>}

        <div className="shepherd-modal__actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="danger"
            onClick={onConfirm}
            disabled={!confirmed || busy}
          >
            {busy ? "Deleting…" : "Delete workspace"}
          </button>
        </div>
      </div>
    </div>
  );
}
