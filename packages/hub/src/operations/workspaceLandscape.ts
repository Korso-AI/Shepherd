/**
 * workspaceLandscape operation: the read-only, whole-workspace view that backs
 * the wallboard's `GET /workspace/landscape` endpoint.
 *
 * Unlike `work`/`sync`, this takes NO session and NO body — it is scoped to the
 * caller's resolved `tenant.workspaceId` (the route `:id` for hosted callers, the
 * single seeded workspace for self-host), NOT the hub's `ALLOWED_WORKSPACE` env.
 * It assembles the three
 * lists the wallboard renders (agents, tasks, announcements), derives presence
 * here (via `presenceFor`, the single staleness definition), and stamps the
 * server's clock so the client computes "expires in / last seen" against the
 * hub rather than the browser.
 */

import type { WorkspaceLandscapeResponseT } from "@shepherd/shared";
import { getContext } from "../context.js";
import { getWorkspaceLandscape } from "../repo.js";
import { presenceFor } from "../presence.js";
import { withContext } from "../scopedDb.js";
import {
  contextForTenant,
  requireWorkspaceId,
  type TenantContext,
} from "../tenant.js";

export async function workspaceLandscape(
  tenant: TenantContext,
): Promise<WorkspaceLandscapeResponseT> {
  const { pool, config } = getContext();
  const workspaceId = requireWorkspaceId(tenant);
  const now = new Date();

  // One transaction so the three reads share a single consistent snapshot.
  // Scoped to the credential's workspace_id (NOT config.ALLOWED_WORKSPACE).
  const rows = await withContext(pool, contextForTenant(tenant), (tx) =>
    getWorkspaceLandscape(tx, workspaceId, now, config.STALE_AFTER_SECONDS),
  );

  return {
    agents: rows.agents.map((a) => ({
      name: a.name,
      human: a.human,
      program: a.program,
      model: a.model,
      repo: a.repo,
      branch: a.branch,
      lastHeartbeatAt: a.lastHeartbeatAt
        ? a.lastHeartbeatAt.toISOString()
        : null,
      presence: presenceFor(a.lastHeartbeatAt, now, config),
    })),
    tasks: rows.tasks.map((t) => ({
      agentName: t.agentName,
      program: t.program,
      model: t.model,
      repo: t.repo,
      intent: t.intent,
      pathGlobs: t.pathGlobs,
      status: t.status,
      createdAt: t.createdAt.toISOString(),
      endedAt: t.endedAt ? t.endedAt.toISOString() : null,
    })),
    announcements: rows.announcements.map((an) => ({
      fromAgentName: an.fromAgentName,
      fromHuman: an.fromHuman,
      body: an.body,
      targetAgentName: an.targetAgentName,
      repo: an.repo,
      fromAdmin: an.fromAdmin,
      toAdmin: an.toAdmin,
      targetMemberName: an.targetMemberName,
      createdAt: an.createdAt.toISOString(),
    })),
    serverTime: now.toISOString(),
  };
}
