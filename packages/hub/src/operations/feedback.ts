/**
 * submitFeedback operation: record a "bug"/"suggestion"/"other" note from the
 * feedback widget. Accepts ANY resolved tenant — self-host TEAM_TOKEN, an agent
 * shp_ token, or a hosted browser call with no route-derived workspace all land
 * a row, capturing whatever workspace/account context happens to be present
 * rather than requiring either (feedback is not workspace-scoped data).
 */

import type { FeedbackRequestT, FeedbackResponseT } from "@shepherd/shared";
import { getContext } from "../context.js";
import { insertFeedback } from "../repo.js";
import { NO_ROUTE_WORKSPACE, type TenantContext } from "../tenant.js";

export async function submitFeedback(
  input: FeedbackRequestT,
  tenant: TenantContext
): Promise<FeedbackResponseT> {
  const { pool } = getContext();

  const id = await insertFeedback(pool, {
    workspaceId: tenant.workspaceId === NO_ROUTE_WORKSPACE ? null : tenant.workspaceId,
    accountId: tenant.accountId ?? null,
    type: input.type,
    body: input.body,
    context: input.context ?? null,
  });

  return { ok: true, id };
}
