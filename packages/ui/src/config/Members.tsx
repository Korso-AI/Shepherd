import { useEffect, useId, useRef, useState } from "react";
import type { MemberSummaryT, RoleT } from "@shepherd/shared";
import { useShepherdClient } from "../context.js";
import { describeError } from "../client.js";
import { ConfirmTransferOwnership } from "./ConfirmTransferOwnership.js";

// ---------------------------------------------------------------------------
// Members — the workspace roster with role-management controls.
//
// Two authority levels gate the controls; the server enforces both, the UI just
// hides what the caller can't do:
//   • Admins (canRemove) may remove plain MEMBERS.
//   • The OWNER (isOwner) may additionally promote/demote members, remove other
//     ADMINS, and transfer ownership. The owner's own row shows no controls (the
//     owner is always an admin and can't be removed/demoted), and the owner is
//     badged "owner" instead of "admin".
//
// Restricting role changes to the owner is the escalation guard: a promoted admin
// cannot then demote the rest and seize the workspace. Self-service "leave" lives
// in <WorkspaceSettings>.
//
// The controls sit behind a per-row "⋯" actions menu (rendered only when the
// caller can act on that row) so the roster reads as a quiet list instead of a
// row of filled buttons.
// ---------------------------------------------------------------------------

export interface MembersProps {
  workspaceId: string;
  /** Bumped by the parent to force a refetch (e.g. after an invite is redeemed). */
  refreshKey?: number;
  /** When true, render the remove control on member rows (the caller gates on admin). */
  canRemove?: boolean;
  /** When true, the caller is the workspace owner: render role + transfer controls. */
  isOwner?: boolean;
  /** Called after a role change, so the parent can refresh anything roster-derived. */
  onMembersChanged?: () => void;
  /** Called after an ownership transfer flips the caller owner→admin, so the shell re-lists workspaces. */
  onWorkspaceChanged?: () => void;
}

export function Members({
  workspaceId,
  refreshKey = 0,
  canRemove = false,
  isOwner = false,
  onMembersChanged,
  onWorkspaceChanged,
}: MembersProps) {
  const client = useShepherdClient();
  const headingId = useId();
  const [members, setMembers] = useState<MemberSummaryT[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // True until the first load() resolves, so the initial fetch shows "Loading…"
  // rather than the genuine "No members." empty state.
  const [loading, setLoading] = useState(true);
  // Per-row in-flight guard (by accountId): disables that row's controls and
  // blocks double-submit for remove OR role change.
  const [busyId, setBusyId] = useState<string | null>(null);
  // The member queued for an ownership transfer (drives the confirm modal), plus
  // the in-flight + error state of the transfer request.
  const [transferTarget, setTransferTarget] = useState<MemberSummaryT | null>(
    null,
  );
  const [transferring, setTransferring] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);
  // The row (by accountId) whose actions menu is open — at most one at a time.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // Host of the OPEN menu (only one exists), for the outside-click dismiss.
  const menuHostRef = useRef<HTMLSpanElement | null>(null);

  // Dismiss the open actions menu on outside-click — same popover behavior as
  // the repo/workspace selectors. mousedown (not click) so it fires before
  // focus moves.
  useEffect(() => {
    if (menuFor === null) return;
    function onDocClick(e: MouseEvent) {
      if (
        menuHostRef.current &&
        !menuHostRef.current.contains(e.target as Node)
      ) {
        setMenuFor(null);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuFor]);

  // Move focus into the freshly-opened menu so keyboard users can Tab the
  // items and Esc out — only on open.
  useEffect(() => {
    if (menuFor === null) return;
    menuHostRef.current
      ?.querySelector<HTMLElement>('[role="menuitem"]')
      ?.focus();
  }, [menuFor]);

  // `keepError` lets a failure path re-sync the roster without wiping the message
  // it just surfaced (a fresh fetch normally clears stale errors).
  async function load({ keepError = false }: { keepError?: boolean } = {}) {
    if (!keepError) setError(null);
    try {
      const res = await client.listMembers(workspaceId);
      setMembers(res.members);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, workspaceId, refreshKey]);

  async function remove(accountId: string, display: string) {
    if (busyId) return;
    setBusyId(accountId);
    setError(null);
    setStatus(null);
    // Optimistically drop the row; re-sync from the server if it rejects.
    setMembers((current) => current.filter((m) => m.accountId !== accountId));
    try {
      await client.removeMember(workspaceId, accountId);
      setStatus(`Removed ${display}`);
    } catch (err) {
      setError(describeError(err));
      // The captured roster may be stale; recover from the server instead,
      // preserving the failure message we just set.
      void load({ keepError: true });
    } finally {
      setBusyId(null);
    }
  }

  async function changeRole(accountId: string, role: RoleT, display: string) {
    if (busyId) return;
    setBusyId(accountId);
    setError(null);
    setStatus(null);
    // Optimistically reflect the new role; re-sync if the server rejects.
    setMembers((current) =>
      current.map((m) => (m.accountId === accountId ? { ...m, role } : m)),
    );
    try {
      await client.setMemberRole(workspaceId, accountId, role);
      setStatus(
        role === "admin"
          ? `Promoted ${display} to admin`
          : `Made ${display} a member`,
      );
      onMembersChanged?.();
    } catch (err) {
      setError(describeError(err));
      void load({ keepError: true });
    } finally {
      setBusyId(null);
    }
  }

  async function confirmTransfer() {
    if (!transferTarget || transferring) return;
    const target = transferTarget;
    const display = memberLabel(target);
    setTransferring(true);
    setTransferError(null);
    try {
      await client.transferOwnership(workspaceId, target.accountId);
      setTransferTarget(null);
      setStatus(`Transferred ownership to ${display}`);
      // The caller just went owner→admin, so re-list workspaces (updates the
      // "Your role" label + owner-only controls) and refetch the roster's badges.
      onWorkspaceChanged?.();
      onMembersChanged?.();
      void load();
    } catch (err) {
      setTransferError(describeError(err));
    } finally {
      setTransferring(false);
    }
  }

  return (
    <section className="shepherd-members" aria-labelledby={headingId}>
      <div className="card-head">
        <h3 id={headingId}>Members</h3>
      </div>
      <div className="card-body">
        {error && <p role="alert">{error}</p>}
        {status && <p role="status">{status}</p>}
        {loading ? (
          <p role="status">Loading…</p>
        ) : members.length === 0 ? (
          <p>No members.</p>
        ) : (
          <ul>
            {members.map((m) => {
              const display = memberLabel(m);
              // The owner may act on everyone but themselves; a plain admin may
              // only remove members. The owner's row is never actionable.
              const showRoleControls = isOwner && !m.isOwner;
              const canRemoveRow =
                !m.isOwner && (m.role === "admin" ? isOwner : canRemove);
              const hasActions = showRoleControls || canRemoveRow;
              const menuOpen = menuFor === m.accountId;
              return (
                <li key={m.accountId}>
                  <span>{display}</span>
                  <span className="role">{m.isOwner ? "owner" : m.role}</span>
                  {hasActions && (
                    <span
                      className="row-actions"
                      ref={menuOpen ? menuHostRef : undefined}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setMenuFor(null);
                      }}
                    >
                      <button
                        type="button"
                        className="row-actions__trig"
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        aria-label={`Actions for ${display}`}
                        onClick={() =>
                          setMenuFor(menuOpen ? null : m.accountId)
                        }
                        disabled={busyId === m.accountId}
                      >
                        ⋯
                      </button>
                      {menuOpen && (
                        <div className="row-actions__menu" role="menu">
                          {showRoleControls && (
                            <>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setMenuFor(null);
                                  void changeRole(
                                    m.accountId,
                                    m.role === "admin" ? "member" : "admin",
                                    display,
                                  );
                                }}
                              >
                                {m.role === "admin"
                                  ? "Make member"
                                  : "Make admin"}
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setMenuFor(null);
                                  setTransferTarget(m);
                                }}
                              >
                                Transfer ownership
                              </button>
                            </>
                          )}
                          {canRemoveRow && (
                            <button
                              type="button"
                              role="menuitem"
                              className="row-actions__danger"
                              aria-label={`Remove ${display}`}
                              onClick={() => {
                                setMenuFor(null);
                                void remove(m.accountId, display);
                              }}
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      )}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {transferTarget && (
        <ConfirmTransferOwnership
          memberName={memberLabel(transferTarget)}
          busy={transferring}
          error={transferError}
          onConfirm={() => void confirmTransfer()}
          onCancel={() => {
            if (!transferring) {
              setTransferTarget(null);
              setTransferError(null);
            }
          }}
        />
      )}
    </section>
  );
}

/** The best available human label for a member row. */
function memberLabel(m: MemberSummaryT): string {
  return m.displayName ?? m.githubLogin ?? m.email ?? m.accountId;
}
