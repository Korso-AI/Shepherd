/**
 * workspaceAnnounce operation: record an announcement sent by the HUMAN operator
 * from the dashboard. Unlike `announce` (agent → hub, carries a sessionId), this
 * has NO session — it is authenticated at the route layer and scoped to the
 * caller's resolved `tenant.workspaceId` (the route `:id` for hosted callers, the
 * single seeded workspace for self-host), NOT the configured `ALLOWED_WORKSPACE`.
 *
 * Sender identity: an account-bearing caller (hosted browser-via-BFF or agent
 * shp_ token) is labelled with THEIR profile name (display name / GitHub login /
 * email), so agents and the feed see WHICH member spoke — and can reply to them
 * by that name via `announce target`. A self-host TEAM_TOKEN (or an account with
 * no profile snapshot yet) falls back to the configured `HUB_ADMIN_LABEL`. Rows
 * are written with NULL `from_session_id` and `from_admin = true`; recipients
 * pull them on their next work/sync/done/announce via the existing per-repo
 * delivery path (fetchPendingAnnouncements).
 *
 * Authorization (§4.4): operator announcements are admin-only in HOSTED mode.
 * An account-bearing caller (a hosted browser-via-BFF user, OR an agent shp_
 * token) must be an ADMIN of the resolved workspace — otherwise requireAdmin
 * throws 403. A self-host TEAM_TOKEN carries no account/role (single-team, full
 * access), so the check is skipped for it. This single op-level guard covers both
 * the `:id` route and the self-host singular alias.
 *
 * Repo scoping:
 *   - DM (targetAgentName set): tagged with the TARGET's most-recent session repo
 *     (resolved server-side), so the per-repo delivery query reaches them. An
 *     unknown/never-connected agent → ValidationError (400).
 *   - Broadcast with `repo`: a single row for that repo.
 *   - Broadcast without `repo`: fan out to every repo agents have connected from.
 *
 * Returns { ok: true, announcementIds }.
 */

import {
  canonicalizeRepo,
  type WorkspaceAnnounceRequestT,
  type WorkspaceAnnounceResponseT,
} from "@shepherd/shared";
import { getContext } from "../context.js";
import {
  insertAdminAnnouncement,
  findAgentRepoForDelivery,
  listWorkspaceRepos,
  accountLabel,
} from "../repo.js";
import { withTransaction } from "../db.js";
import { ValidationError } from "../errors.js";
import { requireWorkspaceId, requireAdmin, type TenantContext } from "../tenant.js";

export async function workspaceAnnounce(
  input: WorkspaceAnnounceRequestT,
  tenant: TenantContext
): Promise<WorkspaceAnnounceResponseT> {
  const { pool, config } = getContext();
  // Scoped to the credential's workspace_id (NOT config.ALLOWED_WORKSPACE).
  const workspaceId = requireWorkspaceId(tenant);
  // Hosted callers (browser-via-BFF or agent shp_ token) carry an account and
  // must be an ADMIN of this workspace (§4.4). A self-host TEAM_TOKEN has no
  // account/role, so it keeps full single-team access — skip the role gate.
  if (tenant.accountId !== undefined) {
    requireAdmin(tenant);
  }
  const targetAgentName = input.targetAgentName ?? null;

  return withTransaction(pool, async (tx) => {
    // Label the row with the SENDING member's name where one is known, so the
    // message reads "alice → ..." (and agents can reply with `target: alice`)
    // rather than the anonymous collective label. Self-host TEAM_TOKEN callers
    // carry no account; a profile-less account falls back the same way.
    const fromLabel =
      (tenant.accountId !== undefined
        ? await accountLabel(tx, tenant.accountId)
        : null) ?? config.HUB_ADMIN_LABEL;

    // Resolve the set of repos to write a row for.
    let repos: string[];
    if (targetAgentName !== null) {
      // DM: deliver into the target's own repo. Reject if we can't place them.
      const repo = await findAgentRepoForDelivery(tx, workspaceId, targetAgentName);
      if (repo === null) {
        throw new ValidationError(
          `Unknown or never-connected agent: ${targetAgentName}`
        );
      }
      repos = [repo];
    } else if (input.repo != null) {
      // Broadcast scoped to a specific repo (the dashboard's selected repo).
      // Canonicalize it the same way `join` canonicalizes a session's repo, so
      // the message lands in the same per-repo bucket teammates deliver from
      // regardless of how the repo was spelled.
      repos = [canonicalizeRepo(input.repo)];
    } else {
      // Broadcast with no repo => fan out to every repo in the workspace.
      repos = await listWorkspaceRepos(tx, workspaceId);
    }

    const announcementIds: number[] = [];
    for (const repo of repos) {
      const id = await insertAdminAnnouncement(tx, {
        workspaceId,
        repo,
        targetAgentName,
        body: input.body,
        fromLabel,
      });
      announcementIds.push(id);
    }

    return { ok: true, announcementIds };
  });
}
