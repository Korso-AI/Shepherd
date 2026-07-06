import { useId, useState } from "react";
import type { WorkspaceSummaryT } from "@shepherd/shared";
import { useShepherdClient } from "../context.js";
import { describeError, ShepherdClientError } from "../client.js";
import { ConfirmDeleteWorkspace } from "./ConfirmDeleteWorkspace.js";
import { AccountActions } from "./AccountActions.js";

// ---------------------------------------------------------------------------
// GeneralSettings — the Config → General tab: identity of the CURRENT workspace
// (name + the caller's role) plus the self-service workspace actions: "Leave
// workspace" (any member) and, for admins, the irreversible "Delete workspace".
//
// Leave lived on the <Members> roster before the sidebar redesign; it moves
// here so Members is purely the roster and General owns workspace-level actions.
// The hub enforces the last-admin guard on leave (design §4.4); a rejected leave
// surfaces as a visible alert rather than a crash — and, because the last admin
// is stuck (they can't leave, correctly), we point them at Delete instead. Delete
// is admin-only, guarded by a type-the-name modal (ConfirmDeleteWorkspace). Both
// onLeft and onDeleted let the shell re-list its workspaces afterward (the account
// may now be in a different / no workspace).
// ---------------------------------------------------------------------------

export interface GeneralSettingsProps {
  /** The active workspace whose identity is shown. */
  workspace: WorkspaceSummaryT;
  /** Called after a successful leave, so the shell refreshes its workspace list. */
  onLeft?: () => void;
  /** Called after a successful delete, so the shell refreshes its workspace list. */
  onDeleted?: () => void;
  /**
   * Hosted session logout hook, rendered as the General tab's account rows
   * (Sign out + Delete account — see AccountActions). The host owns the
   * authentication side effect.
   */
  onLogout?: () => void;
}

export function GeneralSettings({ workspace, onLeft, onDeleted, onLogout }: GeneralSettingsProps) {
  const client = useShepherdClient();
  const headingId = useId();
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  // Set when a leave is rejected because the caller is the last admin (409): they
  // cannot leave by design, so we surface the "delete instead" hint pointing at
  // the Delete section below (which is visible to them, since they are an admin).
  const [lastAdminBlocked, setLastAdminBlocked] = useState(false);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const isAdmin = workspace.role === "admin";

  async function leave() {
    if (leaving) return;
    setLeaving(true);
    setError(null);
    setLastAdminBlocked(false);
    try {
      await client.leave(workspace.id);
      onLeft?.();
    } catch (err) {
      setError(describeError(err));
      // A 409 here is the last-admin guard: the workspace must always keep an
      // admin, so this member cannot leave. Point them at Delete instead.
      if (err instanceof ShepherdClientError && err.status === 409) {
        setLastAdminBlocked(true);
      }
    } finally {
      setLeaving(false);
    }
  }

  async function confirmDelete() {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await client.deleteWorkspace(workspace.id);
      setConfirmOpen(false);
      onDeleted?.();
    } catch (err) {
      setDeleteError(describeError(err));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="shepherd-general" aria-labelledby={headingId}>
      <div className="card-head">
        <h3 id={headingId}>General</h3>
        <p className="card-sub">Your active workspace and its settings.</p>
      </div>

      <div className="card-body">
        {error && <p role="alert">{error}</p>}
        {lastAdminBlocked && isAdmin && (
          <p className="helper">
            You&apos;re the last admin, so you can&apos;t leave. To remove this
            workspace entirely, delete it below.
          </p>
        )}

        <div className="field">
          <label>Workspace name</label>
          <p className="readonly-value">{workspace.name}</p>
        </div>

        <div className="field">
          <label>Your role</label>
          <p className="readonly-value">{workspace.role}</p>
        </div>

        <div className="field leave">
          <label>Leave workspace</label>
          <p className="helper">
            Remove yourself from this workspace. You&apos;ll need a new invite to rejoin.
          </p>
          <button type="button" className="danger" onClick={() => void leave()} disabled={leaving}>
            Leave workspace
          </button>
        </div>

        {isAdmin && (
          <div className="field delete">
            <label>Delete workspace</label>
            <p className="helper">
              Permanently delete this workspace and all of its data. This cannot be undone.
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
              Delete workspace
            </button>
          </div>
        )}

        {/* Account-level rows (Sign out · Delete account) — same .field format
            as the workspace options above; see AccountActions. */}
        <AccountActions onLogout={onLogout} />
      </div>

      {confirmOpen && (
        <ConfirmDeleteWorkspace
          workspaceName={workspace.name}
          busy={deleting}
          error={deleteError}
          onConfirm={() => void confirmDelete()}
          onCancel={() => {
            if (!deleting) setConfirmOpen(false);
          }}
        />
      )}
    </section>
  );
}
