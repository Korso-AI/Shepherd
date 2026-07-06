/**
 * Layer 2 of the zero-setup first-run flow: put the link question to the USER
 * directly via MCP elicitation — a native client popup, no agent mediation and
 * no client configuration.
 *
 * Cardinal rule — ACCEPT-ONLY: only an accepted form submission records a
 * decision. Some clients auto-answer popups they can't render (observed: Codex
 * declares the elicitation capability but answers `{action:"decline"}` within
 * milliseconds, openai/codex#13405), so a decline/cancel/error must always mean
 * "couldn't ask" — ask again next session — and never "the user said no".
 * "Don't ask again" is therefore an enum VALUE inside the form, reachable only
 * through an accept.
 *
 * The schema is deliberately lowest-common-denominator (one flat string enum):
 * the MCP spec restricts elicitation schemas to flat primitives, and the
 * simplest possible form renders correctly on the widest set of clients.
 */

/** The in-form opt-out choice. A VALUE, not a button — see accept-only above. */
export const NEVER_ASK_CHOICE = "No — don't ask again";

/** Minimal structural view of an elicitation exchange (seam for tests). */
export interface ElicitParams {
  message: string;
  requestedSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}
export interface ElicitResponse {
  action?: string;
  content?: Record<string, unknown>;
}
export type ElicitFn = (params: ElicitParams) => Promise<ElicitResponse>;

export type LinkPopupOutcome = "linked" | "declined" | "unanswered";

/**
 * Offer the link popup once. Returns what was durably decided:
 *
 *  - `linked`     : the user accepted a workspace; `linkWorkspace(slug)` ran.
 *  - `declined`   : the user accepted the never-ask choice; `neverAskAgain()` ran.
 *  - `unanswered` : everything else — no workspaces to offer, hub unreachable,
 *                   dialog dismissed/declined/cancelled, elicitation error, or
 *                   a failure while linking. Nothing was recorded; the question
 *                   stays open for the next session.
 *
 * Never throws (fail-open); the caller decides whether/how to log.
 */
export async function offerLinkPopup({
  repoName,
  elicit,
  listWorkspaces,
  linkWorkspace,
  neverAskAgain,
}: {
  /** Human-readable repo identity for the dialog message. */
  repoName: string;
  /** The elicitation transport (real: server.server.elicitInput). */
  elicit: ElicitFn;
  /** The workspaces this account may link to (hosted list / self-host single). */
  listWorkspaces: () => Promise<string[]>;
  /** Commit the accepted choice (marker + hot activation). */
  linkWorkspace: (slug: string) => Promise<void>;
  /** Record the accepted never-ask choice (local decline). */
  neverAskAgain: () => void;
}): Promise<{ outcome: LinkPopupOutcome; workspace?: string }> {
  let slugs: string[];
  try {
    slugs = await listWorkspaces();
  } catch {
    return { outcome: "unanswered" }; // hub unreachable — don't bother the user
  }
  if (slugs.length === 0) return { outcome: "unanswered" }; // nothing to offer

  let response: ElicitResponse;
  try {
    response = await elicit({
      message:
        `Shepherd: "${repoName}" isn't linked to a team workspace, so teammates can't ` +
        `see the work happening here. Link it to start coordinating? This writes a small ` +
        `.shepherd file naming the workspace (commit it so teammates inherit the link). ` +
        `Dismiss to decide later — you'll be asked again next session.`,
      requestedSchema: {
        type: "object",
        properties: {
          decision: {
            type: "string",
            title: "Workspace",
            description:
              `Use the arrow keys (→) to view your workspaces. Pick one to link ` +
              `this repo, or "${NEVER_ASK_CHOICE}".`,
            enum: [...slugs, NEVER_ASK_CHOICE],
          },
        },
        required: ["decision"],
      },
    });
  } catch {
    return { outcome: "unanswered" }; // unsupported/timeout/transport error
  }

  // Accept-only: any non-accept action is "couldn't ask", recorded nowhere.
  if (response?.action !== "accept") return { outcome: "unanswered" };
  const decision = response.content?.decision;
  if (typeof decision !== "string") return { outcome: "unanswered" };

  if (decision === NEVER_ASK_CHOICE) {
    neverAskAgain();
    return { outcome: "declined" };
  }

  if (!slugs.includes(decision)) return { outcome: "unanswered" };

  try {
    await linkWorkspace(decision);
  } catch {
    // The choice may be partially committed (e.g. marker written, join failed —
    // linkWorkspace itself is fail-open for that); a hard throw here means we
    // can't claim "linked", so leave the question open rather than lie.
    return { outcome: "unanswered" };
  }
  return { outcome: "linked", workspace: decision };
}
