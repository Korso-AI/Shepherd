import { useEffect, useId, useState } from "react";
import type { MemberSummaryT } from "@shepherd/shared";
import { useShepherdClient } from "../context.js";
import { describeError } from "../client.js";

// ---------------------------------------------------------------------------
// Members — the workspace roster with an admin-only remove control.
//
// Admin-gating is the caller's responsibility: the remove control is rendered
// only when the parent passes `canRemove` (the Config panel sets it behind the
// workspace's `role === "admin"` check), so this component just fetches the
// roster and exposes a remove button per member. The server enforces the
// last-admin guard (design §4.4); a rejected remove surfaces as a visible
// message rather than a crash. Self-service "leave" lives in <GeneralSettings>.
// ---------------------------------------------------------------------------

export interface MembersProps {
  workspaceId: string;
  /** Bumped by the parent to force a refetch (e.g. after an invite is redeemed). */
  refreshKey?: number;
  /** When true, render the per-member remove control (the caller gates on admin). */
  canRemove?: boolean;
}

export function Members({ workspaceId, refreshKey = 0, canRemove = false }: MembersProps) {
  const client = useShepherdClient();
  const headingId = useId();
  const [members, setMembers] = useState<MemberSummaryT[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // True until the first load() resolves, so the initial fetch shows "Loading…"
  // rather than the genuine "No members." empty state.
  const [loading, setLoading] = useState(true);
  // Per-row in-flight remove guard (by accountId), used to disable the button
  // and block double-submit.
  const [removingId, setRemovingId] = useState<string | null>(null);

  // `keepError` lets the remove-failure path re-sync the roster without wiping
  // the message it just surfaced (a fresh fetch normally clears stale errors).
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
    if (removingId) return;
    setRemovingId(accountId);
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
      setRemovingId(null);
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
              const display = m.displayName ?? m.githubLogin ?? m.email ?? m.accountId;
              return (
                <li key={m.accountId}>
                  <span>{display}</span>
                  <span className="role">{m.role}</span>
                  {canRemove && (
                    <button
                      type="button"
                      aria-label={`Remove ${display}`}
                      onClick={() => void remove(m.accountId, display)}
                      disabled={removingId === m.accountId}
                    >
                      Remove
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
