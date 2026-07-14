/**
 * submitFeedback operation: record a "bug"/"suggestion"/"other" note from the
 * feedback widget. Accepts ANY resolved tenant — self-host TEAM_TOKEN, an agent
 * shp_ token, or a hosted browser call with no route-derived workspace all land
 * a row, capturing whatever workspace/account context happens to be present
 * rather than requiring either (feedback is not workspace-scoped data).
 *
 * When Resend is configured (RESEND_API_KEY + INVITE_EMAIL_FROM — the sender
 * is shared with email invites), each submission is also emailed to
 * FEEDBACK_EMAIL_TO (or, when that optional var is unset, back to
 * INVITE_EMAIL_FROM), fire-and-forget: the row is the source of truth, so a
 * mail failure is logged but never fails or delays the response.
 */

import type { FeedbackRequestT, FeedbackResponseT } from "@shepherd/shared";
import { getContext } from "../context.js";
import { withContext } from "../scopedDb.js";
import { sendFeedbackEmail } from "../email.js";
import {
  findWorkspaceById,
  getAccountProfile,
  insertFeedback,
} from "../repo.js";
import {
  contextForTenant,
  NO_ROUTE_WORKSPACE,
  type TenantContext,
} from "../tenant.js";

/**
 * In-flight detached notification sends. Production never awaits these (the
 * response must not wait on mail — see the module header); tests drain them
 * via {@link __drainFeedbackEmails} so a still-running send cannot bleed past
 * a test boundary into the next test's assertions.
 */
const pendingEmails = new Set<Promise<void>>();

/**
 * Test-only: resolve once every in-flight feedback notification has settled
 * (the same test seam pattern as tenant.ts's __resetRateLimiter).
 */
export async function __drainFeedbackEmails(): Promise<void> {
  while (pendingEmails.size > 0) {
    await Promise.allSettled([...pendingEmails]);
  }
}

export async function submitFeedback(
  input: FeedbackRequestT,
  tenant: TenantContext,
): Promise<FeedbackResponseT> {
  const { pool, config } = getContext();

  const workspaceId =
    tenant.workspaceId === NO_ROUTE_WORKSPACE ? null : tenant.workspaceId;
  const accountId = tenant.accountId ?? null;
  const context = input.context ?? null;
  // Workspace context when the tenant carries a concrete workspace, else account.
  const dbContext = contextForTenant(tenant);

  const id = await withContext(pool, dbContext, (db) =>
    insertFeedback(db, {
      workspaceId,
      accountId,
      type: input.type,
      body: input.body,
      context,
    }),
  );

  if (config.RESEND_API_KEY && config.INVITE_EMAIL_FROM) {
    // FEEDBACK_EMAIL_TO is optional (no org-specific default ships). When it is
    // unset, fall back to INVITE_EMAIL_FROM as the recipient — the sender address
    // is a valid mailbox, so feedback lands there rather than the feature being
    // silently dropped. (Sending as a whole is still gated on Resend being set.)
    //
    // Bind the resolved credentials HERE, inside the guard, so the narrowing to
    // non-undefined survives into the async closure below (TS drops it across a
    // nested function boundary otherwise).
    const emailConfig = {
      RESEND_API_KEY: config.RESEND_API_KEY,
      INVITE_EMAIL_FROM: config.INVITE_EMAIL_FROM,
      FEEDBACK_EMAIL_TO: config.FEEDBACK_EMAIL_TO ?? config.INVITE_EMAIL_FROM,
    };
    // Resolve the raw account/workspace ids to human identities (email, display
    // name, workspace name) so the notification is readable, rather than opaque
    // ids. Both lookups are best-effort — a null profile/workspace row (or a
    // failed query) still emails with the raw id preserved by the formatter.
    const emailWork = (async () => {
      // One transaction for both lookups: same context, one connection
      // checkout instead of two withContext calls on this detached path. The
      // reads are sequential — a single transaction client serializes queries
      // anyway (and READ COMMITTED gives each statement its own snapshot, so
      // batching would buy no consistency either).
      const { profile, workspace } = await withContext(
        pool,
        dbContext,
        async (db) => ({
          profile: accountId ? await getAccountProfile(db, accountId) : null,
          workspace: workspaceId
            ? await findWorkspaceById(db, workspaceId)
            : null,
        }),
      );
      await sendFeedbackEmail(
        {
          id,
          type: input.type,
          body: input.body,
          account: accountId
            ? {
                id: accountId,
                name: profile?.display_name ?? profile?.github_login ?? null,
                email: profile?.email ?? null,
              }
            : null,
          workspace: workspaceId
            ? {
                id: workspaceId,
                name: workspace?.name ?? null,
                slug: workspace?.slug ?? null,
              }
            : null,
          context,
        },
        emailConfig,
      );
    })().catch((err) => {
      console.error("[feedback] notification email failed:", err);
    });
    pendingEmails.add(emailWork);
    void emailWork.finally(() => pendingEmails.delete(emailWork));
  }

  return { ok: true, id };
}
