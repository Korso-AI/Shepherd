import { useEffect, useId } from "react";

// ---------------------------------------------------------------------------
// ConfirmTransferOwnership — the confirmation modal guarding "Transfer
// ownership". Unlike the delete modals this is NOT type-to-confirm: handing off
// ownership is reversible (the new owner can transfer it back) and promotes the
// target rather than destroying data, so a clear explanation + an explicit
// confirm is a proportionate guard. Same modal chrome as ConfirmDeleteWorkspace
// (backdrop + role="dialog", Escape / backdrop click cancel unless busy).
// ---------------------------------------------------------------------------

export interface ConfirmTransferOwnershipProps {
  /** The display name of the member who will become the new owner. */
  memberName: string;
  /** True while the transfer request is in flight — disables the controls. */
  busy: boolean;
  /** A failed-transfer message to show inline, or null. */
  error: string | null;
  /** Fired when the confirmed Transfer button is pressed. */
  onConfirm: () => void;
  /** Fired on Cancel / Escape / backdrop click (ignored while busy). */
  onCancel: () => void;
}

export function ConfirmTransferOwnership({
  memberName,
  busy,
  error,
  onConfirm,
  onCancel,
}: ConfirmTransferOwnershipProps) {
  const headingId = useId();
  const descId = useId();

  // Escape cancels (unless a transfer is in flight).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

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
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={headingId}>Transfer ownership</h3>
        <p id={descId} className="shepherd-modal__body">
          Make <b>{memberName}</b> the owner of this workspace. They&apos;ll be able to
          change members&apos; roles and transfer ownership. You&apos;ll stay an admin,
          but you can no longer manage roles unless ownership is transferred back.
        </p>

        {error && <p role="alert">{error}</p>}

        <div className="shepherd-modal__actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={busy}>
            {busy ? "Transferring…" : "Transfer ownership"}
          </button>
        </div>
      </div>
    </div>
  );
}
