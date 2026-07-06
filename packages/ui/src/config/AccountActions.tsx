import { useState } from "react";
import { useShepherdClient } from "../context.js";
import { describeError } from "../client.js";
import { ConfirmDeleteAccount } from "./ConfirmDeleteAccount.js";

// ---------------------------------------------------------------------------
// AccountActions — the two ACCOUNT-level rows of the Config → General tab:
// "Sign out" and the irreversible "Delete account". Rendered as plain `.field`
// blocks (label + helper + button) so they read exactly like the workspace
// options above them, replacing the old free-floating <SignOutAction> footer
// that trailed every Config section.
//
// Also reused by the no-workspace Config screen (an account with no workspace
// still needs both actions), wrapped there in its own "Account" card.
//
// The host owns authentication: onLogout is the injected session-clearing hook,
// invoked for a plain sign-out AND after a successful account deletion (the
// session's account no longer exists, so the only sane next step is out).
// ---------------------------------------------------------------------------

export interface AccountActionsProps {
  /**
   * Hosted session logout hook. Shepherd renders the controls while the host
   * owns the authentication side effect. Omitting it hides the Sign out row
   * (delete account still signs out implicitly when provided).
   */
  onLogout?: () => void;
}

export function AccountActions({ onLogout }: AccountActionsProps) {
  const client = useShepherdClient();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function confirmDelete() {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await client.deleteAccount();
      setConfirmOpen(false);
      // The account is gone; clear the (now-orphaned) session.
      onLogout?.();
    } catch (err) {
      setDeleteError(describeError(err));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      {onLogout && (
        <div className="field signout">
          <label>Sign out</label>
          <p className="helper">Sign out of this Shepherd dashboard session.</p>
          <button type="button" onClick={onLogout}>
            Sign out
          </button>
        </div>
      )}

      <div className="field delete-account">
        <label>Delete account</label>
        <p className="helper">
          Permanently delete your account. You leave every workspace, and
          workspaces where you&apos;re the only member are deleted with all
          their data. This cannot be undone.
        </p>
        <button
          type="button"
          className="danger"
          onClick={() => {
            setDeleteError(null);
            setConfirmOpen(true);
          }}
          disabled={deleting}
        >
          Delete account
        </button>
      </div>

      {confirmOpen && (
        <ConfirmDeleteAccount
          busy={deleting}
          error={deleteError}
          onConfirm={() => void confirmDelete()}
          onCancel={() => {
            if (!deleting) setConfirmOpen(false);
          }}
        />
      )}
    </>
  );
}
