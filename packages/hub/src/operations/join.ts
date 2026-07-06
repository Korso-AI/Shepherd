/**
 * join operation: register a NEW per-session agent identity for a human in a
 * workspace and open a new session.
 *
 * Every join mints a fresh agent row. Names follow `{humanHandle}-{ordinal}`,
 * reusing the LOWEST free ordinal among the human's currently-RESERVED names —
 * those still backed by a live session, an active claim, or an outstanding
 * change record (see reservedAgentNamesForHandle) — so a human's concurrent
 * sessions get stable, low, human-readable names (alex-rivera-1, alex-rivera-2,
 * …) and an ordinal is recycled only once nothing still references it.
 *
 * Returns { agentName, sessionId }.
 */

import type { JoinRequestT, JoinResponseT } from "@shepherd/shared";
import { getContext } from "../context.js";
import { DEFAULT_UNCOMMITTED_GRACE_SECONDS } from "../config.js";
import { ValidationError, AuthError, HubError } from "../errors.js";
import {
  requireWorkspaceId,
  requireAccountId,
  NO_ROUTE_WORKSPACE,
  type TenantContext,
} from "../tenant.js";
import { generateName, canonicalizeRepo } from "@shepherd/shared";
import {
  findAgentByName,
  createAgent,
  createSession,
  reservedAgentNamesForHandle,
  findWorkspaceById,
  findWorkspaceBySlug,
  findMembership,
  getAccountProfile,
  type AgentRow,
} from "../repo.js";
import { withTransaction } from "../db.js";

/** True when the pg error is a unique-constraint violation (SQLSTATE 23505). */
function isUniqueViolation(e: unknown): e is { code: string; constraint?: string } {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code: string }).code === "23505"
  );
}

/**
 * The local-part of an email address (everything before the first `@`), trimmed;
 * or null when the input is empty/whitespace or has no usable local-part. A
 * string with no `@` is returned as-is (trimmed), so this is safe to call on any
 * identity string.
 */
function emailLocalPart(value: string | null | undefined): string | null {
  if (!value) return null;
  const atIdx = value.indexOf("@");
  const local = (atIdx === -1 ? value : value.slice(0, atIdx)).trim();
  return local.length > 0 ? local : null;
}

/**
 * Normalize a raw human string into a name handle: reduce an email to its
 * local-part (the domain is noise, not identity — "a@example.test" would otherwise
 * slug to "agmailcom"), then lowercase, trim, collapse internal whitespace runs
 * to `-`, strip anything outside `[a-z0-9-]`, collapse repeated `-` and trim
 * leading/trailing `-`. Returns "" when nothing usable remains (e.g. "***").
 */
function normalizeHandle(human: string): string {
  const atIdx = human.indexOf("@");
  const base = atIdx === -1 ? human : human.slice(0, atIdx);
  return base
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Lowest positive integer not present in the set of ordinals parsed from the
 * reserved names belonging to `handle`'s ordinal family.
 */
function lowestFreeOrdinal(handle: string, reservedNames: string[]): number {
  const re = new RegExp(`^${escapeRegExp(handle)}-(\\d+)$`);
  const taken = new Set<number>();
  for (const name of reservedNames) {
    const m = re.exec(name);
    if (m) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n > 0) taken.add(n);
    }
  }
  let ordinal = 1;
  while (taken.has(ordinal)) ordinal++;
  return ordinal;
}

export async function join(
  input: JoinRequestT,
  tenant: TenantContext
): Promise<JoinResponseT> {
  const { pool, config } = getContext();

  // Resolve WHICH workspace this join lands in. There are two shapes of caller,
  // discriminated by whether the credential fixed a workspace:
  //
  //  - ACCOUNT-SCOPED (workspaceId === NO_ROUTE_WORKSPACE): the token binds an
  //    account but NO single workspace, so the body's `workspace` slug (the
  //    client's `.shepherd` marker) SELECTS the workspace — validated against
  //    LIVE membership. An unknown slug AND a slug the account is not a member of
  //    BOTH collapse to an identical 404 — never reveal whether a workspace the
  //    caller can't access exists (the same no-existence-disclosure posture as
  //    resolveTenant's browser :id path and resolveSession). The MCP client's
  //    hostedWorkspaceRejected guard keys on 403/404 from /join, so a
  //    wrong/forbidden marker still surfaces as its workspaceMismatch() advisory
  //    rather than a silent wrong-workspace join.
  //
  //  - WORKSPACE-SCOPED / SELF-HOST (concrete workspaceId): the credential already
  //    fixed the workspace; the body slug must MATCH it, NEVER select it.
  //     · SELF-HOST (no account): mismatch → ValidationError (400) so a stale
  //       client pointed at the wrong workspace fails loudly.
  //     · HOSTED legacy workspace-token (account present): mismatch → AuthError
  //       (403), NOT 400, so the same MCP workspace-match guard trips (letting it
  //       through would be a SILENT wrong-workspace join — success in the token's
  //       workspace while the marker/operator believe it landed elsewhere).
  let workspaceId: string;
  if (tenant.workspaceId === NO_ROUTE_WORKSPACE) {
    const accountId = requireAccountId(tenant);
    const ws = await findWorkspaceBySlug(pool, input.workspace);
    if (ws === null) {
      throw new AuthError(404, "workspace not found");
    }
    const membership = await findMembership(pool, accountId, ws.id);
    if (membership === null) {
      // Same 404 (and identical message) as the unknown-slug case above: a
      // non-member must not be able to distinguish "exists but you're not in it"
      // from "doesn't exist", or an authenticated account-token holder could
      // enumerate which workspace slugs exist on the hub.
      throw new AuthError(404, "workspace not found");
    }
    workspaceId = ws.id;
  } else {
    workspaceId = requireWorkspaceId(tenant);
    const ws = await findWorkspaceById(pool, workspaceId);
    if (ws === null || input.workspace !== ws.slug) {
      if (tenant.accountId === undefined) {
        throw new ValidationError(
          `Workspace '${input.workspace}' is not allowed. Expected '${ws?.slug ?? "<unknown>"}'.`
        );
      }
      throw new AuthError(
        403,
        `Workspace '${input.workspace}' does not match this credential's workspace.`
      );
    }
  }

  // `human` identity: whenever an account is known (account-scoped OR legacy
  // hosted), prefer the account's real identity over the client-supplied string,
  // so the wallboard shows the authenticated user rather than whatever the client
  // sent (which is derived from local git config, often a personal email). Order:
  // github_login → display_name → the email's local-part. Self-host (no account)
  // keeps the client-supplied `human`.
  let human = input.human;
  if (tenant.accountId !== undefined) {
    const profile = await getAccountProfile(pool, tenant.accountId);
    const identity =
      profile?.github_login ??
      profile?.display_name ??
      emailLocalPart(profile?.email) ??
      null;
    if (identity !== null && identity.trim().length > 0) {
      human = identity;
    }
  }

  const now = new Date();
  const handle = normalizeHandle(human);

  return withTransaction(pool, async (tx) => {
    let agent: AgentRow | null = null;

    // Bounded retry loop. Each attempt: compute the target name, then
    // reclaim-or-create under a SAVEPOINT so a concurrent join that took the
    // ordinal between our live-set read and insert (23505 on (workspace,name))
    // can be recovered by recomputing the ordinal — the racing row is now live.
    for (let attempt = 0; attempt < 5 && !agent; attempt++) {
      // Derive the target name. With no usable handle we fall back to a random
      // generated name (no ordinal logic).
      const targetName =
        handle === ""
          ? generateName()
          : `${handle}-${lowestFreeOrdinal(
              handle,
              await reservedAgentNamesForHandle(
                tx,
                workspaceId,
                handle,
                now,
                config.STALE_AFTER_SECONDS,
                config.CHANGE_RECORD_TTL_SECONDS,
                config.UNCOMMITTED_GRACE_SECONDS ?? DEFAULT_UNCOMMITTED_GRACE_SECONDS
              )
            )}`;

      // Reclaim a dead-but-undeleted row at this name, if one exists. A still-
      // RESERVED holder (live session, active claim, or outstanding change
      // record) would have pushed the ordinal past `targetName`, so anything we
      // find here is necessarily unreferenced and safe to reuse.
      const existing = await findAgentByName(tx, workspaceId, targetName);
      if (existing) {
        agent = existing;
        break;
      }

      await tx.query("SAVEPOINT join_create");
      try {
        agent = await createAgent(tx, {
          workspaceId,
          name: targetName,
          human,
          program: input.program,
          model: input.model ?? null,
        });
        await tx.query("RELEASE SAVEPOINT join_create");
      } catch (e) {
        if (isUniqueViolation(e)) {
          // A concurrent join claimed targetName first. Roll back and retry;
          // the racing row is now live, so the recomputed ordinal advances.
          await tx.query("ROLLBACK TO SAVEPOINT join_create");
        } else {
          throw e;
        }
      }
    }

    // Final fallback: exhausted ordinal retries → try a random name once.
    if (!agent) {
      await tx.query("SAVEPOINT join_create");
      try {
        agent = await createAgent(tx, {
          workspaceId,
          name: generateName(),
          human,
          program: input.program,
          model: input.model ?? null,
        });
        await tx.query("RELEASE SAVEPOINT join_create");
      } catch (e) {
        if (isUniqueViolation(e)) {
          await tx.query("ROLLBACK TO SAVEPOINT join_create");
          throw new HubError(
            "Could not allocate a unique agent name after retries"
          );
        }
        throw e;
      }
    }

    // Canonicalize repo HERE, at the single ingestion point — repo is the
    // coordination boundary and the hub owns it. Every downstream row
    // (work_items, announcements, change_records) derives its repo from this
    // session, so normalizing once means teammates converge regardless of which
    // client version they run (an old client reporting "Org/Repo" still lands on
    // "repo"). Same canonicalizeRepo the client uses (@shepherd/shared).
    const session = await createSession(tx, {
      workspaceId,
      agentId: agent.id,
      repo: canonicalizeRepo(input.repo),
      branch: input.branch,
    });

    return {
      agentName: agent.name,
      sessionId: session.id,
    };
  });
}
