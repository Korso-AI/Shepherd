/**
 * announce operation: record a broadcast or targeted announcement in the
 * workspace+repo's announcement log, and deliver any pending announcements back
 * to the caller.
 *
 * The announcement the caller just sent creates no delivery row for anyone here;
 * recipients pull it on their next work/sync/done/announce.
 *
 * Announce is a model-visible turn (the agent reads its result), so we also
 * surface the caller's OWN pending inbox — messages otherwise wait for the next
 * work/sync. fetchPendingAnnouncements excludes the caller's own sends, so the
 * just-recorded announcement is never echoed back. (Heartbeat deliberately does
 * NOT deliver: its result never reaches the model.)
 *
 * Returns { ok: true, announcementId, announcements }.
 */

import type {
  AnnounceRequestT,
  AnnounceResponseT,
  MemberSummaryT,
} from "@shepherd/shared";
import { getContext } from "../context.js";
import {
  touchHeartbeat,
  insertAnnouncement,
  fetchPendingAnnouncements,
  recordAnnouncementDeliveries,
  liveAgentNamesInRepo,
  listMembers,
} from "../repo.js";
import { resolveSession } from "../sessionScope.js";
import { withTransaction } from "../db.js";
import { ValidationError } from "../errors.js";
import { type TenantContext } from "../tenant.js";

/** The name a member is shown under in feeds and matched by as a target. */
function memberLabel(m: MemberSummaryT): string {
  return m.displayName ?? m.githubLogin ?? m.email ?? m.accountId;
}

/** Case-insensitive match of `target` against a member's known identifiers. */
function memberMatches(m: MemberSummaryT, target: string): boolean {
  const t = target.toLowerCase();
  return (
    m.displayName?.toLowerCase() === t ||
    m.githubLogin?.toLowerCase() === t ||
    m.email?.toLowerCase() === t
  );
}

/** Where an announcement is headed after target resolution. */
interface ResolvedTarget {
  targetAgentName: string | null;
  toAdmin: boolean;
  targetAccountId: string | null;
  targetLabel: string | null;
}

export async function announce(
  input: AnnounceRequestT,
  tenant: TenantContext,
): Promise<AnnounceResponseT> {
  const { pool, config } = getContext();

  // Exactly ONE way of addressing per message. `target` is the unified field;
  // the legacy pair stays supported for older clients but can't be combined
  // with it (or with each other). Reject the ambiguous request before writing.
  if (
    input.target != null &&
    (input.targetAgentName != null || input.toAdmin)
  ) {
    throw new ValidationError(
      "target replaces targetAgentName/toAdmin — set only target",
    );
  }
  if (input.toAdmin && input.targetAgentName != null) {
    throw new ValidationError(
      "toAdmin and targetAgentName are mutually exclusive",
    );
  }

  return withTransaction(pool, async (tx) => {
    // Resolve + authorize the session as the FIRST statement (no second
    // connection). resolveSession handles both credential kinds; a session the
    // caller may not reach throws UnknownSessionError (→ 404), the cross-tenant
    // gate. The concrete workspace is read from the session below.
    const session = await resolveSession(tx, tenant, input.sessionId);
    const now = new Date();
    await touchHeartbeat(tx, session.id, now);

    // A DIRECTED message must reach someone real: a name that matches no live
    // agent and no member would be recorded as a DM nobody receives while still
    // looking sent on the wall. Resolve (and reject) before writing. The hub
    // stores targetAgentName verbatim and delivery matches it exactly against an
    // agent's name (handle-ordinal, e.g. "maeriyn-4"), so the bare handle
    // ("Maeriyn") or a typo must be rejected too. (The sender just heartbeated
    // above, so self-targeting still passes.)
    let resolved: ResolvedTarget = {
      targetAgentName: input.targetAgentName ?? null,
      toAdmin: input.toAdmin ?? false,
      targetAccountId: null,
      targetLabel: null,
    };

    if (input.target != null || input.targetAgentName != null) {
      const liveNames = await liveAgentNamesInRepo(
        tx,
        session.workspaceId,
        session.repo,
        now,
        config.STALE_AFTER_SECONDS,
      );

      if (input.target != null) {
        // Unified resolution order: live agent in the sender's repo → the
        // operator label ("admin" by default; the collective dashboard) →
        // a workspace member (a specific dashboard user).
        if (liveNames.includes(input.target)) {
          resolved = { ...resolved, targetAgentName: input.target };
        } else if (
          input.target.toLowerCase() === config.HUB_ADMIN_LABEL.toLowerCase()
        ) {
          resolved = { ...resolved, toAdmin: true };
        } else {
          const members = await listMembers(tx, session.workspaceId);
          const hits = members.filter((m) => memberMatches(m, input.target!));
          if (hits.length > 1) {
            throw new ValidationError(
              `'${input.target}' matches ${hits.length} workspace members — ` +
                `use their GitHub login or email to disambiguate.`,
            );
          }
          const member = hits[0];
          if (member === undefined) {
            const others = liveNames.filter((n) => n !== session.agentName);
            const agentHint = others.length
              ? `Live agents in this repo: ${others.join(", ")}.`
              : `No other agents are currently connected to this repo.`;
            const labels = members.map(memberLabel);
            const memberHint = labels.length
              ? ` Workspace members: ${labels.join(", ")}.`
              : "";
            throw new ValidationError(
              `No live agent or workspace member named '${input.target}'. ` +
                `Agent names need their numeric suffix as shown in the landscape ` +
                `(e.g. 'alex-rivera-2', not 'alex-rivera'). ${agentHint}${memberHint} ` +
                `Omit target to broadcast to all agents, or use ` +
                `'${config.HUB_ADMIN_LABEL}' to reach the dashboard.`,
            );
          }
          // Member-directed: to_admin=true keeps it OUT of every agent's
          // delivery; the account id + name snapshot say WHO it's for.
          resolved = {
            ...resolved,
            toAdmin: true,
            targetAccountId: member.accountId,
            targetLabel: memberLabel(member),
          };
        }
      } else if (
        input.targetAgentName != null &&
        !liveNames.includes(input.targetAgentName)
      ) {
        const others = liveNames.filter((n) => n !== session.agentName);
        const hint = others.length
          ? `Live agents in this repo: ${others.join(", ")}.`
          : `No other agents are currently connected to this repo.`;
        throw new ValidationError(
          `No live agent named '${input.targetAgentName}' in this repo. ` +
            `A directed message needs the exact agent name as shown in the ` +
            `landscape (including its numeric suffix, e.g. 'alex-rivera-2', not ` +
            `'alex-rivera'). ${hint} Omit targetAgentName to broadcast to everyone.`,
        );
      }
    }

    const announcementId = await insertAnnouncement(tx, {
      workspaceId: session.workspaceId,
      repo: session.repo,
      fromSessionId: session.id,
      targetAgentName: resolved.targetAgentName,
      body: input.body,
      toAdmin: resolved.toAdmin,
      targetAccountId: resolved.targetAccountId,
      targetLabel: resolved.targetLabel,
    });

    const announcements = await fetchPendingAnnouncements(tx, session);
    await recordAnnouncementDeliveries(
      tx,
      session.id,
      announcements.map((a) => a.id),
    );

    return { ok: true, announcementId, announcements };
  });
}
