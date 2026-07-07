/**
 * Outbound email — currently just the one email invites send. A thin wrapper
 * over Resend's REST API via plain `fetch` (Node 18+ has it globally) rather
 * than the `resend` SDK: one call, one shape, not worth a dependency for.
 */

const RESEND_API_URL = "https://api.resend.com/emails";

export interface SendInviteEmailParams {
  to: string;
  joinLink: string;
  workspaceName: string;
}

/**
 * Send the one-time invite-link email. Callers (operations/invites.ts) are
 * responsible for checking `RESEND_API_KEY`/`INVITE_EMAIL_FROM` are configured
 * BEFORE calling this — it assumes both are present and throws if Resend's API
 * rejects the request (network failure, bad key, unverified `from` domain,
 * etc.), so the caller's request fails loudly rather than reporting "sent"
 * for an email that never went anywhere.
 */
export async function sendInviteEmail(
  params: SendInviteEmailParams,
  config: { RESEND_API_KEY: string; INVITE_EMAIL_FROM: string }
): Promise<void> {
  const { to, joinLink, workspaceName } = params;

  const res = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.INVITE_EMAIL_FROM,
      to,
      subject: `You've been invited to join ${workspaceName} on Shepherd`,
      html: renderInviteEmailHtml({ joinLink, workspaceName }),
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend API error (${res.status}): ${detail || res.statusText}`);
  }
}

function renderInviteEmailHtml(params: { joinLink: string; workspaceName: string }): string {
  const { joinLink, workspaceName } = params;
  return `
    <p>You've been invited to join <strong>${escapeHtml(workspaceName)}</strong> on Shepherd.</p>
    <p><a href="${escapeHtml(joinLink)}">${escapeHtml(joinLink)}</a></p>
    <p>This link works once — it expires as soon as it's used.</p>
  `.trim();
}

/** Minimal HTML-entity escape for the two dynamic values interpolated above. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Feedback notifications
// ---------------------------------------------------------------------------

import type { FeedbackContextT } from "@shepherd/shared";

export interface SendFeedbackEmailParams {
  id: string;
  type: string;
  body: string;
  /**
   * The submitting account, resolved to a display identity by the caller
   * (operations/feedback.ts) from account_profiles. `name`/`email` are null when
   * no profile row exists — the raw `id` is always kept so support can look it up.
   */
  account: { id: string; name: string | null; email: string | null } | null;
  /**
   * The workspace, resolved to its human name/slug by the caller. `name`/`slug`
   * are null when the id no longer resolves to a row (e.g. deleted workspace).
   */
  workspace: { id: string; name: string | null; slug: string | null } | null;
  context: FeedbackContextT | null;
}

/** "Jane Doe <jane@x.com> (accId)" → the friendliest form the data allows. */
function formatAccount(account: SendFeedbackEmailParams["account"]): string {
  if (!account) return "—";
  const { id, name, email } = account;
  const label = name && email ? `${name} <${email}>` : (email ?? name);
  return label ? `${label} (${id})` : id;
}

/** "Acme Team (acme · wsId)" → falls back to the raw id when unresolved. */
function formatWorkspace(workspace: SendFeedbackEmailParams["workspace"]): string {
  if (!workspace) return "—";
  const { id, name, slug } = workspace;
  return name ? `${name} (${slug ?? id})` : id;
}

/**
 * Email one feedback-widget submission to the configured inbox. Same contract
 * as sendInviteEmail: the caller checks configuration BEFORE calling, and this
 * throws on a Resend rejection — but unlike invites, the feedback caller fires
 * and forgets (operations/feedback.ts), so a throw is logged, never surfaced.
 */
export async function sendFeedbackEmail(
  params: SendFeedbackEmailParams,
  config: { RESEND_API_KEY: string; INVITE_EMAIL_FROM: string; FEEDBACK_EMAIL_TO: string }
): Promise<void> {
  const { id, type, body, account, workspace, context } = params;

  const snippet = body.length > 60 ? `${body.slice(0, 60)}…` : body;
  const text = [
    body,
    "",
    `type: ${type}`,
    `account: ${formatAccount(account)}`,
    `workspace: ${formatWorkspace(workspace)}`,
    ...Object.entries(context ?? {})
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}: ${value}`),
    `feedback id: ${id}`,
  ].join("\n");

  const res = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.INVITE_EMAIL_FROM,
      to: config.FEEDBACK_EMAIL_TO,
      subject: `[Feedback] ${type} — ${snippet}`,
      text,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend API error (${res.status}): ${detail || res.statusText}`);
  }
}
