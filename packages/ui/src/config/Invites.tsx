import { useEffect, useId, useState } from "react";
import type { InviteResponseT } from "@shepherd/shared";
import { useShepherdClient } from "../context.js";
import { describeError } from "../client.js";

// ---------------------------------------------------------------------------
// Invites — admin-only controls for adding people to the CURRENT workspace.
// Lives in the Config → Members tab (inviting is an "add a member" action), so
// the caller renders it only for admins (behind the workspace's role check).
//
// Two paths, both extracted verbatim from the former <Workspaces> section:
//   • Code invite: createInvite → shows the code, a client-constructed join
//     link, and its use count; revoke retracts the on-screen code.
//   • Email invite: inviteByEmail → sends a one-time-use join link, reporting
//     success/failure inline.
//
// Invite display is intentionally single-active (only the most recently created
// code is shown); prior codes remain live server-side. InviteResponse carries
// no `link`, so the shareable URL is built client-side from the code against the
// current origin (encoded for path-safety, parity with client.ts).
// ---------------------------------------------------------------------------

export interface InvitesProps {
  /** The workspace invites are minted against. */
  workspaceId: string;
  /** Called after an invite is created (may change the pending-invite roster). */
  onMembersChanged?: () => void;
}

export function Invites({ workspaceId, onMembersChanged }: InvitesProps) {
  const client = useShepherdClient();
  const headingId = useId();

  const [invite, setInvite] = useState<InviteResponseT | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [emailAddress, setEmailAddress] = useState("");
  const [emailStatus, setEmailStatus] = useState<string | null>(null);
  const [emailBusy, setEmailBusy] = useState(false);

  // Which of the two copyables flashed "Copied" most recently (cleared after 2s).
  const [copied, setCopied] = useState<"code" | "link" | null>(null);

  // Clear any displayed invite/email status when the workspace changes, so a
  // code minted for one workspace never lingers on another's screen.
  useEffect(() => {
    setInvite(null);
    setEmailStatus(null);
  }, [workspaceId]);

  async function createInvite() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await client.createInvite(workspaceId, {});
      setInvite(res);
      onMembersChanged?.();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function revokeInvite() {
    if (!invite || busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.revokeInvite(workspaceId, invite.code);
      setInvite(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function sendEmailInvite() {
    if (!emailAddress.trim() || emailBusy) return;
    setEmailBusy(true);
    setEmailStatus(null);
    try {
      const res = await client.inviteByEmail(workspaceId, emailAddress.trim());
      setEmailStatus(`Invite sent to ${res.email}.`);
      setEmailAddress("");
      onMembersChanged?.();
    } catch (err) {
      setEmailStatus(describeError(err));
    } finally {
      setEmailBusy(false);
    }
  }

  const joinLink = invite
    ? `${window.location.origin}/shepherd/join/${encodeURIComponent(invite.code)}`
    : null;

  async function copy(what: "code" | "link", value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(what);
    setTimeout(() => setCopied((c) => (c === what ? null : c)), 2000);
  }

  return (
    <section className="shepherd-invites" aria-labelledby={headingId}>
      <div className="card-head">
        <h3 id={headingId}>Invite people</h3>
        <p className="card-sub">Share a code, or send a one-time join link by email.</p>
      </div>

      <div className="card-body">
        {error && <p role="alert">{error}</p>}

        <div className="field invites">
          <label>Invite by code</label>
          <p className="helper">Anyone with the code can join this workspace.</p>
          {/* The freshly-created code sits ABOVE the button, so the newest
              invite is what you see first — the button below mints another. */}
          {invite && (
            <div className="invite-result">
              <div className="invite-result__head">
                <span className="invite-result__eyebrow">Invite code</span>
                <span className="invite-uses">
                  {invite.maxUses === null
                    ? `${invite.useCount} uses`
                    : `${invite.useCount} / ${invite.maxUses} uses`}
                </span>
                <button
                  type="button"
                  className="link-btn"
                  aria-label="Revoke invite"
                  onClick={() => void revokeInvite()}
                  disabled={busy}
                >
                  Revoke
                </button>
              </div>
              <div className="invite-result__copyrow">
                <code>{invite.code}</code>
                <button
                  type="button"
                  className="copy-btn"
                  onClick={() => void copy("code", invite.code)}
                >
                  {copied === "code" ? "Copied" : "Copy"}
                </button>
              </div>
              {joinLink && (
                <div className="invite-result__copyrow invite-result__copyrow--link">
                  <a href={joinLink}>{joinLink}</a>
                  <button
                    type="button"
                    className="copy-btn"
                    onClick={() => void copy("link", joinLink)}
                  >
                    {copied === "link" ? "Copied" : "Copy link"}
                  </button>
                </div>
              )}
            </div>
          )}
          <button type="button" onClick={() => void createInvite()} disabled={busy}>
            Create invite
          </button>
        </div>

        <div className="field email-invite">
          <label htmlFor="invite-email">Invite by email</label>
          <p className="helper">Send a one-time-use join link directly to someone&apos;s inbox.</p>
          <div className="field__row">
            <input
              id="invite-email"
              type="email"
              placeholder="name@example.com"
              value={emailAddress}
              onChange={(e) => setEmailAddress(e.target.value)}
            />
            <button type="button" onClick={() => void sendEmailInvite()} disabled={emailBusy}>
              Send invite
            </button>
          </div>
          {emailStatus && <p className="email-invite__status">{emailStatus}</p>}
        </div>
      </div>
    </section>
  );
}
