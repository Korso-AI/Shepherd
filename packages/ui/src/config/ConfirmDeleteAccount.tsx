import { useEffect, useId, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// ConfirmDeleteAccount — the type-to-confirm modal guarding the irreversible
// "Delete account" action. Mirrors ConfirmDeleteWorkspace's chrome (backdrop +
// role="dialog", initial focus on the input, Escape / backdrop-click cancel,
// never while the delete is in flight); the typed phrase is fixed rather than
// a name, since an account has no user-facing name to retype.
// ---------------------------------------------------------------------------

/** The exact phrase the operator must type to enable Delete. */
const CONFIRM_PHRASE = "delete my account";

export interface ConfirmDeleteAccountProps {
  /** True while the delete request is in flight — disables the controls. */
  busy: boolean;
  /** A failed-delete message to show inline, or null. */
  error: string | null;
  /** Fired when the confirmed Delete button is pressed. */
  onConfirm: () => void;
  /** Fired on Cancel / Escape / backdrop click (ignored while busy). */
  onCancel: () => void;
}

export function ConfirmDeleteAccount({
  busy,
  error,
  onConfirm,
  onCancel,
}: ConfirmDeleteAccountProps) {
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

  const confirmed = typed === CONFIRM_PHRASE;

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
        <h3 id={headingId}>Delete account</h3>
        <p id={descId} className="shepherd-modal__body">
          This permanently deletes your account: you leave every workspace,
          workspaces where you were the only member are deleted with all their
          data, and every agent token you created stops working. This cannot be
          undone.
        </p>

        <label htmlFor={`${headingId}-input`} className="shepherd-modal__label">
          Type <b>{CONFIRM_PHRASE}</b> to confirm
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
            {busy ? "Deleting…" : "Delete account"}
          </button>
        </div>
      </div>
    </div>
  );
}
