/**
 * Agent-token management operations: mint / list / revoke the `shp_` tokens an
 * agent uses to authenticate into the hub. There are TWO surfaces, distinguished
 * only by whether the tenant carries a route-derived workspace:
 *
 *  - ACCOUNT-scoped (flat `/tokens`): a non-`:id` route, so resolveTenant
 *    yields `NO_ROUTE_WORKSPACE` ("") with an accountId (browser-via-BFF, or an
 *    account-scoped agent token). Mint stores `workspace_id NULL` (a token bound
 *    to the account, reachable in every workspace it is a member of); list returns
 *    every token the account owns.
 *  - WORKSPACE-narrowed (`/workspaces/:id/tokens`): a `:id` route, so
 *    resolveTenant has ALREADY validated the browser caller is a MEMBER of `:id`
 *    (a non-member is rejected 404 in the onRequest hook). Mint stores that
 *    concrete `workspace_id` (a token locked to one workspace, the CI case); list
 *    returns that workspace's tokens.
 *
 * Both surfaces require an `accountId` (the token is owned by an account), so a
 * self-host TEAM_TOKEN — which carries none — is rejected 401 by requireAccountId.
 *
 *  - mint:   generate a `shp_<base64url≥32-byte>` raw token, store ONLY its SHA-256
 *            hash, and return the raw token EXACTLY ONCE (it is never persisted or
 *            logged and can never be retrieved again — list returns metadata only).
 *  - list:   the tokens in scope (account- or workspace-scoped, per above) as
 *            non-secret metadata — never the hash or the raw token.
 *  - revoke: the caller's OWN token only. Ownership (account_id) is enforced
 *            atomically in SQL (revokeOwnApiToken's WHERE), so a caller can never
 *            revoke another account's token; that mismatch reads as 404.
 */

import crypto from "crypto";

import type {
  MintTokenRequestT,
  MintTokenResponseT,
  ListTokensResponseT,
} from "@shepherd/shared";

import { getContext } from "../context.js";
import { AuthError } from "../errors.js";
import {
  insertApiToken,
  listApiTokens,
  listApiTokensForAccount,
  revokeOwnApiToken,
} from "../repo.js";
import {
  hashToken,
  requireAccountId,
  requireWorkspaceId,
  NO_ROUTE_WORKSPACE,
  type TenantContext,
} from "../tenant.js";

/**
 * Raw entropy (bytes) behind a minted token. ≥32 per design §4.2; base64url of 32
 * bytes is 43 chars, so the emitted `shp_…` token carries ≥256 bits of entropy.
 */
const TOKEN_ENTROPY_BYTES = 32;

/**
 * Generate a fresh raw agent token: the `shp_` prefix plus ≥32 random bytes
 * encoded url-safe (base64url, no padding). This plaintext is returned to the
 * caller exactly once and is NEVER stored — only its SHA-256 hash is persisted.
 */
function generateRawToken(): string {
  const secret = crypto.randomBytes(TOKEN_ENTROPY_BYTES).toString("base64url");
  return `shp_${secret}`;
}

/**
 * Mint a new token for the caller's account. Returns the raw `shp_` token ONCE
 * alongside its id; the hub stores only the hash. The scope follows the route:
 * on the flat `/tokens` path the tenant carries no route workspace
 * (NO_ROUTE_WORKSPACE), so the token is ACCOUNT-scoped (`workspace_id NULL`); on a
 * `/workspaces/:id/tokens` path it is narrowed to that concrete, already
 * membership-validated workspace. ONE mint body, ONE branch on the workspace.
 */
export async function mintToken(
  input: MintTokenRequestT,
  tenant: TenantContext
): Promise<MintTokenResponseT> {
  const { pool } = getContext();
  const accountId = requireAccountId(tenant);
  const workspaceId =
    tenant.workspaceId === NO_ROUTE_WORKSPACE ? null : requireWorkspaceId(tenant);

  const rawToken = generateRawToken();
  const summary = await insertApiToken(pool, {
    workspaceId,
    accountId,
    tokenHash: hashToken(rawToken),
    name: input.name ?? null,
  });

  // The raw token is surfaced here and ONLY here — never persisted or logged.
  return { token: rawToken, id: summary.id };
}

/**
 * List the caller's tokens as non-secret metadata. On the flat `/tokens` path
 * (no route workspace) this is ACCOUNT-scoped — every token the account owns; on a
 * `/workspaces/:id/tokens` path it is that workspace's tokens.
 */
export async function listTokens(
  tenant: TenantContext
): Promise<ListTokensResponseT> {
  const { pool } = getContext();
  if (tenant.workspaceId === NO_ROUTE_WORKSPACE) {
    const accountId = requireAccountId(tenant);
    const tokens = await listApiTokensForAccount(pool, accountId);
    return { tokens };
  }
  const tokens = await listApiTokens(pool, requireWorkspaceId(tenant));
  return { tokens };
}

/**
 * Revoke the caller's OWN token by id. Ownership (account_id) is enforced in the
 * repo WHERE clause, so a token owned by another account — or any already-revoked /
 * unknown id — affects zero rows and surfaces as 404 (never reveal another
 * account's token, or that the id exists). Works for both account-scoped and
 * workspace-narrowed tokens: ownership keys on account_id, not the workspace.
 */
export async function revokeToken(
  tokenId: string,
  tenant: TenantContext
): Promise<{ revoked: true }> {
  const { pool } = getContext();
  const accountId = requireAccountId(tenant);

  const revoked = await revokeOwnApiToken(pool, accountId, tokenId);
  if (!revoked) {
    throw new AuthError(404, "token not found");
  }
  return { revoked: true };
}
