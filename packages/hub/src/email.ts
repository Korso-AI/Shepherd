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
