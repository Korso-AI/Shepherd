import { AccountActions } from "./AccountActions.js";

// ---------------------------------------------------------------------------
// AccountSettings — the Config → Account tab: the ACCOUNT-level actions (Sign
// out · Delete account), split out of the workspace-scoped "Workspace" tab so
// account concerns no longer sit mixed in with workspace ones. It is a thin card
// wrapper around <AccountActions>; the same card is reused by the no-workspace
// Config shell (an account with no workspace still needs both actions).
// ---------------------------------------------------------------------------

export interface AccountSettingsProps {
  /** Hosted session logout hook, forwarded to AccountActions. */
  onLogout?: () => void;
}

export function AccountSettings({ onLogout }: AccountSettingsProps) {
  return (
    <section className="shepherd-general config-account" aria-label="Account">
      <div className="card-head">
        <h3>Account</h3>
        <p className="card-sub">Your Shepherd dashboard session and account.</p>
      </div>
      <div className="card-body">
        <AccountActions onLogout={onLogout} />
      </div>
    </section>
  );
}
