/**
 * submitFeedback operation: record a "bug"/"suggestion"/"other" note from the
 * feedback widget. Accepts ANY resolved tenant — self-host TEAM_TOKEN, an agent
 * shp_ token, or a hosted browser call with no route-derived workspace all land
 * a row, capturing whatever workspace/account context happens to be present
 * rather than requiring either (feedback is not workspace-scoped data).
 *
 * When Resend is configured (RESEND_API_KEY + INVITE_EMAIL_FROM — the sender
 * is shared with email invites), each submission is also emailed to
 * FEEDBACK_EMAIL_TO, fire-and-forget: the row is the source of truth, so a
 * mail failure is logged but never fails or delays the response.
 */

import type { FeedbackRequestT, FeedbackResponseT } from "@shepherd/shared";
import { getContext } from "../context.js";
import { sendFeedbackEmail } from "../email.js";
import { insertFeedback } from "../repo.js";
import { NO_ROUTE_WORKSPACE, type TenantContext } from "../tenant.js";

export async function submitFeedback(
  input: FeedbackRequestT,
  tenant: TenantContext
): Promise<FeedbackResponseT> {
  const { pool, config } = getContext();

  const workspaceId =
    tenant.workspaceId === NO_ROUTE_WORKSPACE ? null : tenant.workspaceId;
  const accountId = tenant.accountId ?? null;
  const context = input.context ?? null;

  const id = await insertFeedback(pool, {
    workspaceId,
    accountId,
    type: input.type,
    body: input.body,
    context,
  });

  if (config.RESEND_API_KEY && config.INVITE_EMAIL_FROM) {
    void sendFeedbackEmail(
      { id, type: input.type, body: input.body, accountId, workspaceId, context },
      {
        RESEND_API_KEY: config.RESEND_API_KEY,
        INVITE_EMAIL_FROM: config.INVITE_EMAIL_FROM,
        FEEDBACK_EMAIL_TO: config.FEEDBACK_EMAIL_TO,
      }
    ).catch((err) => {
      console.error("[feedback] notification email failed:", err);
    });
  }

  return { ok: true, id };
}
