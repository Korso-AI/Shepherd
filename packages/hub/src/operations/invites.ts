/**
 * Invite operations: create / revoke / redeem the codes that let a
 * signed-in account join a workspace.
 *
 *  - createInvite (admin):  POST /workspaces/:id/invites — mint a high-entropy
 *      code into the caller's workspace. resolveTenant has already validated the
 *      browser-via-BFF caller is a MEMBER of `:id` and set `tenant.role`, so the
 *      gate here is `requireAdmin`. Defaults: 7-day expiry, unlimited uses (the
 *      link works until explicitly revoked); expiry and use-cap are overridable
 *      via the request body. Role is fixed at `member` — the selectable-role
 *      surface was removed in an earlier security review.
 *
 *  - inviteByEmail (admin): POST /workspaces/:id/invites/email — mints an
 *      invite the same way but fixed at `maxUses: 1` (the existing atomic
 *      use-cap guard already makes it dead-on-redemption, no separate expiry
 *      logic needed) and emails the join link directly to the given address
 *      instead of returning a shareable code. 501s via NotConfiguredError if
 *      this deployment never set RESEND_API_KEY/INVITE_EMAIL_FROM/PUBLIC_WEB_URL.
 *
 *  - revokeInvite (admin):  POST /workspaces/:id/invites/:code/revoke — revoke a
 *      code SCOPED TO `:id`. A caller cannot revoke another workspace's invite by
 *      guessing its code: revokeInviteByCode's WHERE pins BOTH workspace_id AND
 *      code, so a cross-workspace code matches zero rows → 404.
 *
 *  - redeemInvite (account): POST /invites/:code/redeem — the PUBLIC, security-
 *      critical route. It is NOT under `/workspaces/:id`, so resolveTenant does NO
 *      route-membership check; this operation pins the trust EXPLICITLY:
 *        * requireAccountId — a self-host TEAM_TOKEN (no accountId) is rejected.
 *        * the credential MUST be the browser-via-BFF path: `tenant.via === "browser"`.
 *          An agent token is rejected — a leaked token (workspace- OR account-scoped)
 *          must not be able to self-join NEW workspaces (design §8, plan 3.5). We pin
 *          on `via`, NOT the workspaceId sentinel: an ACCOUNT-scoped agent token now
 *          resolves to the SAME `""` workspaceId a browser has on a non-`:id` route,
 *          so the sentinel can no longer discriminate credential KIND (plan 1.2).
 *        * a forged x-account-id with no/invalid x-internal-token never reaches
 *          here authenticated — resolveTenant throws 401 in the onRequest hook.
 *      The workspace comes from the INVITE, not the route. Already-member is a
 *      no-op success that does NOT burn a use; otherwise membership + use-claim
 *      happen in ONE transaction, with incrementInviteUse as the atomic guard for
 *      revocation, expiry, and the use cap.
 */

import crypto from "crypto";

import type {
  CreateInviteRequestT,
  InviteByEmailResponseT,
  InviteResponseT,
  ListEmailInvitesResponseT,
  RedeemInviteResponseT,
  RoleT,
} from "@shepherd/shared";

import { getContext } from "../context.js";
import { withTransaction } from "../db.js";
import { AuthError, InviteError, NotConfiguredError } from "../errors.js";
import { sendInviteEmail } from "../email.js";
import {
  createInvite as createInviteRow,
  findInviteByCode,
  listPendingEmailInvites,
  revokeInviteByCode,
  incrementInviteUse,
  addMembership,
  findMembership,
  findWorkspaceById,
} from "../repo.js";
import {
  requireAccountId,
  requireAdmin,
  requireWorkspaceId,
  type TenantContext,
} from "../tenant.js";

// ---------------------------------------------------------------------------
// Invite defaults
// ---------------------------------------------------------------------------

/** Default expiry, in days, when the request omits `expiresInDays`. */
const DEFAULT_EXPIRES_IN_DAYS = 7;
/** Default redemption cap when the request omits `maxUses`: none — the
 *  code/link invite is unlimited-use until an admin explicitly revokes it. */
const DEFAULT_MAX_USES = null;
/** Every email invite is exactly one-time-use — it dies on first redemption. */
const EMAIL_INVITE_MAX_USES = 1;
/** Default role granted on redemption when the request omits `role`. */
const DEFAULT_ROLE: RoleT = "member";
/** Random bytes behind a code: 16 bytes → ≥128-bit entropy (matches §4.2 floor). */
const CODE_ENTROPY_BYTES = 16;

// ---------------------------------------------------------------------------
// Code generation — url-safe base62 over ≥128 bits of entropy
// ---------------------------------------------------------------------------

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Encode a byte buffer as base62 ([0-9A-Za-z]) via repeated big-integer division.
 * Deliberately base62 — NOT base64url — so the code is fully url-safe AND free of
 * the `-`/`_`/`=` characters base64url uses (a code lands in a `/join/:code` URL
 * and is often copy-pasted/double-clicked, where word-boundary punctuation is a
 * footgun). 16 random bytes encode to 21–22 base62 chars, i.e. ≥128 bits.
 */
function base62Encode(bytes: Buffer): string {
  let value = BigInt("0x" + (bytes.toString("hex") || "0"));
  if (value === 0n) return "0";
  const base = 62n;
  let out = "";
  while (value > 0n) {
    const rem = Number(value % base);
    out = BASE62[rem]! + out;
    value /= base;
  }
  return out;
}

/** A fresh, high-entropy, url-safe invite code (base62 over 16 random bytes). */
function generateCode(): string {
  return base62Encode(crypto.randomBytes(CODE_ENTROPY_BYTES));
}

// ---------------------------------------------------------------------------
// Redeem throttle — per-account failed-attempt counter (anti-enumeration)
// ---------------------------------------------------------------------------

// TODO(operational hardening): in-memory only — shared-store upgrade alongside the pre-auth throttle bucket.
//
// The generic rate bucket (tenant.ts) only engages AFTER a credential resolves,
// and accounts are free, so a single account could enumerate invite codes against
// the public redeem route. This counts CONSECUTIVE invalid-code (410) redeems per
// account within a window and 429s once they exceed a small threshold. It is the
// rate defense; InviteError's single 410 status is the signal defense. Keyed by
// accountId (the identity that survives a resolved BFF credential); a successful
// redeem clears the account's counter, and one account's failures never affect
// another's (the cross-account test pins this). Single-instance Map; resets on
// process restart, mirroring the pre-auth throttle bucket.

/** Invalid-code redeems allowed per account before we start 429-ing. */
const REDEEM_FAIL_THRESHOLD = 10;
/** Sliding window (ms) over which failures accumulate. */
const REDEEM_FAIL_WINDOW_MS = 60_000;

interface FailCounter {
  count: number;
  /** ms epoch the current window started; reset once it lapses. */
  windowStart: number;
}

// TODO(operational hardening): never evicted — one entry per distinct account that has failed a
// redeem, bounded by the account-id space and reset on restart.
const redeemFailures = new Map<string, FailCounter>();

/**
 * Throw 429 if `accountId` has already exceeded the failed-redeem threshold in
 * the current window. Call BEFORE attempting a redeem so a throttled account is
 * turned away without touching the DB.
 */
function checkRedeemThrottle(
  accountId: string,
  now: number = Date.now(),
): void {
  const entry = redeemFailures.get(accountId);
  if (entry === undefined) return;
  if (now - entry.windowStart >= REDEEM_FAIL_WINDOW_MS) {
    // Window lapsed — the counter is stale; let this attempt through.
    redeemFailures.delete(accountId);
    return;
  }
  if (entry.count >= REDEEM_FAIL_THRESHOLD) {
    throw new AuthError(429, "too many invalid invite redemptions");
  }
}

/** Record one failed (invalid-code) redeem for `accountId`. */
function recordRedeemFailure(
  accountId: string,
  now: number = Date.now(),
): void {
  const entry = redeemFailures.get(accountId);
  if (entry === undefined || now - entry.windowStart >= REDEEM_FAIL_WINDOW_MS) {
    redeemFailures.set(accountId, { count: 1, windowStart: now });
    return;
  }
  entry.count += 1;
}

/** Clear an account's failed-redeem counter after a successful redeem. */
function clearRedeemFailures(accountId: string): void {
  redeemFailures.delete(accountId);
}

/** Test-only: clear the redeem throttle so each test starts fresh. */
export function __resetRedeemThrottle(): void {
  redeemFailures.clear();
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Create a redeemable invite into the caller's workspace. Admin-only. Mints a
 * high-entropy code, computes expiry from `expiresInDays` (default 7d), and
 * persists with `maxUses` (default: unlimited, until revoked). The granted
 * role is always `member` (DEFAULT_ROLE) — invites do not carry a selectable
 * role (removed in an earlier security review).
 */
export async function createInvite(
  input: CreateInviteRequestT,
  tenant: TenantContext,
): Promise<InviteResponseT> {
  const { pool } = getContext();
  const workspaceId = requireWorkspaceId(tenant);
  requireAdmin(tenant);

  // resolveTenant set tenant.accountId for the browser-via-BFF caller; admins
  // are always accounts, so this is present, and it stamps created_by.
  const createdBy = requireAccountId(tenant);

  const expiresInDays = input.expiresInDays ?? DEFAULT_EXPIRES_IN_DAYS;
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

  const invite = await createInviteRow(pool, {
    workspaceId,
    code: generateCode(),
    createdBy,
    roleGranted: DEFAULT_ROLE,
    maxUses: input.maxUses ?? DEFAULT_MAX_USES,
    expiresAt,
  });

  return {
    code: invite.code,
    expiresAt: invite.expiresAt?.toISOString() ?? null,
    maxUses: invite.maxUses,
    useCount: invite.useCount,
  };
}

/**
 * Mint a one-time-use invite (maxUses fixed at 1 — dies on first redemption,
 * enforced by incrementInviteUse's existing atomic guard) and email its join
 * link directly to `email`. Admin-only, same gating as createInvite.
 *
 * Requires RESEND_API_KEY/INVITE_EMAIL_FROM/PUBLIC_WEB_URL to be configured
 * (config.ts's superRefine keeps them paired); throws NotConfiguredError (501)
 * otherwise so a self-host deployment that skipped email setup fails loudly
 * rather than the caller getting a false "sent" response.
 */
export async function inviteByEmail(
  email: string,
  tenant: TenantContext,
): Promise<InviteByEmailResponseT> {
  const { pool, config } = getContext();
  const workspaceId = requireWorkspaceId(tenant);
  requireAdmin(tenant);
  const createdBy = requireAccountId(tenant);

  if (
    !config.RESEND_API_KEY ||
    !config.INVITE_EMAIL_FROM ||
    !config.PUBLIC_WEB_URL
  ) {
    throw new NotConfiguredError(
      "email invites are not configured on this server",
    );
  }

  const workspace = await findWorkspaceById(pool, workspaceId);
  if (workspace === null) {
    throw new AuthError(404, "workspace not found");
  }

  const expiresAt = new Date(
    Date.now() + DEFAULT_EXPIRES_IN_DAYS * 24 * 60 * 60 * 1000,
  );
  const invite = await createInviteRow(pool, {
    workspaceId,
    code: generateCode(),
    createdBy,
    roleGranted: DEFAULT_ROLE,
    maxUses: EMAIL_INVITE_MAX_USES,
    expiresAt,
    // Recorded so the Config UI can list who was invited and hasn't joined yet.
    email,
  });

  const joinLink = `${config.PUBLIC_WEB_URL}/shepherd/join/${encodeURIComponent(invite.code)}`;
  await sendInviteEmail(
    { to: email, joinLink, workspaceName: workspace.name },
    {
      RESEND_API_KEY: config.RESEND_API_KEY,
      INVITE_EMAIL_FROM: config.INVITE_EMAIL_FROM,
    },
  );

  return { email, sentAt: new Date().toISOString() };
}

/**
 * List the workspace's PENDING email invites (sent, not yet redeemed / revoked /
 * expired), newest first. Admin-only, same gating as the create paths — this is
 * the roster behind the "Invite by email" form. The invite CODE is deliberately
 * not returned: the join link already left by email, and this list is
 * status-only (the redeemed row simply disappears, because an email invite is
 * one-time-use and a claimed use excludes it from the pending predicate).
 */
export async function listEmailInvites(
  tenant: TenantContext,
): Promise<ListEmailInvitesResponseT> {
  const { pool } = getContext();
  const workspaceId = requireWorkspaceId(tenant);
  requireAdmin(tenant);

  const rows = await listPendingEmailInvites(pool, workspaceId);
  return {
    invites: rows.map((r) => ({
      id: r.id,
      // The pending predicate is `email IS NOT NULL`, so this is always set.
      email: r.email ?? "",
      sentAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt?.toISOString() ?? null,
    })),
  };
}

/**
 * Revoke an invite by code, SCOPED to the caller's workspace. Admin-only. A code
 * that does not belong to this workspace (or is unknown / already revoked)
 * matches zero rows and surfaces as 404 — a caller can never revoke another
 * workspace's invite by guessing its code, and we never reveal that a code exists
 * elsewhere.
 */
export async function revokeInvite(
  code: string,
  tenant: TenantContext,
): Promise<{ revoked: true }> {
  const { pool } = getContext();
  const workspaceId = requireWorkspaceId(tenant);
  requireAdmin(tenant);

  const revoked = await revokeInviteByCode(pool, workspaceId, code);
  if (!revoked) {
    throw new AuthError(404, "invite not found");
  }
  return { revoked: true };
}

/**
 * Redeem an invite as a signed-in account. See the file header for the full trust
 * model. Returns the joined workspace; throws AuthError (401/403) when the caller
 * is not an authenticated browser account, and InviteError (410) when the code is
 * invalid/revoked/expired/exhausted.
 */
export async function redeemInvite(
  code: string,
  tenant: TenantContext,
): Promise<RedeemInviteResponseT> {
  const { pool } = getContext();

  // 1. The caller must be an authenticated ACCOUNT (rejects self-host TEAM_TOKEN,
  //    which carries no accountId). A forged x-account-id never reaches here — it
  //    is rejected 401 by resolveTenant in the onRequest hook before this runs.
  const accountId = requireAccountId(tenant);

  // 2. Pin to the BROWSER-via-BFF path via the credential-KIND discriminator. An
  //    agent token (workspace- OR account-scoped) must NOT be able to self-join
  //    NEW workspaces. We gate on `tenant.via`, NOT the workspaceId sentinel: an
  //    account-scoped agent token resolves to the SAME "" workspaceId a browser
  //    has on a non-:id route, so the sentinel can no longer tell them apart.
  if (tenant.via !== "browser") {
    throw new AuthError(
      403,
      "invite redemption requires a browser account session",
    );
  }

  // 3. Throttle invalid-code enumeration BEFORE touching the DB.
  checkRedeemThrottle(accountId);

  // 4. Resolve the code. findInviteByCode already excludes revoked invites (reads
  //    as null). Expiry/use-count are NOT checked here — the atomic claim in
  //    incrementInviteUse enforces them under the row lock.
  const invite = await findInviteByCode(pool, code);
  if (invite === null) {
    recordRedeemFailure(accountId);
    throw new InviteError("invite invalid or no longer redeemable");
  }

  const workspaceId = invite.workspaceId;

  // 5. Already a member → no-op success. Do NOT burn a use (or re-grant the role):
  //    the user simply "lands in" the workspace at their CURRENT role.
  const existing = await findMembership(pool, accountId, workspaceId);
  if (existing !== null) {
    clearRedeemFailures(accountId);
    return await buildRedeemResponse(workspaceId, existing.role, accountId);
  }

  // 6. Fresh join: claim a use AND add the membership in ONE transaction. The
  //    claim is the atomic guard — if it returns null (revoked/expired/exhausted,
  //    incl. a race to exhaustion between step 4 and here) we roll back by throwing
  //    so no membership is added.
  await withTransaction(pool, async (tx) => {
    const claimed = await incrementInviteUse(tx, code);
    if (claimed === null) {
      throw new InviteError("invite invalid or no longer redeemable");
    }
    await addMembership(tx, {
      workspaceId,
      accountId,
      role: invite.roleGranted,
    });
  }).catch((err) => {
    if (err instanceof InviteError) {
      recordRedeemFailure(accountId);
    }
    throw err;
  });

  clearRedeemFailures(accountId);
  return await buildRedeemResponse(workspaceId, invite.roleGranted, accountId);
}

/** Assemble the RedeemInviteResponse for a workspace the caller now belongs to. */
async function buildRedeemResponse(
  workspaceId: string,
  role: RoleT,
  accountId: string,
): Promise<RedeemInviteResponseT> {
  const { pool } = getContext();
  const ws = await findWorkspaceById(pool, workspaceId);
  if (ws === null) {
    // The invite referenced a workspace that no longer exists — treat as invalid.
    throw new InviteError("invite invalid or no longer redeemable");
  }
  return {
    // isOwner is derived, not granted by the invite: a redeemer is the owner only
    // if they are the workspace's creator (the "already a member" branch can land
    // the original owner back via an invite link).
    workspace: {
      id: ws.id,
      slug: ws.slug,
      name: ws.name,
      role,
      isOwner: ws.createdBy === accountId,
    },
  };
}
