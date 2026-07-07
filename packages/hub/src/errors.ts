/**
 * Error taxonomy for @shepherd/hub.
 *
 * HubError is the base class for all domain errors thrown by the hub.
 * Route handlers catch these and map them to HTTP status codes.
 */

/** Base class for all hub domain errors. */
export class HubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/**
 * Thrown when a session ID is not found in the database.
 * Maps to HTTP 404 in the route layer.
 */
export class UnknownSessionError extends HubError {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
  }
}

/**
 * Thrown when a request fails validation (e.g. workspace not in ALLOWED_WORKSPACE).
 * Maps to HTTP 400 in the route layer.
 */
export class ValidationError extends HubError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Thrown by the auth/tenancy layer (`resolveTenant`) when a request cannot be
 * resolved to a tenant. SECURITY-CRITICAL: the `message` carried here is the
 * INTERNAL reason for logging only — the server hook replies with a GENERIC
 * message keyed off `status`, never echoing this string (so we never reveal
 * which credential failed, whether a workspace exists, etc.).
 *
 * `status` is the HTTP status the hook should reply with:
 *   - 400 malformed call (e.g. BFF call missing x-account-id)
 *   - 401 no/invalid credential
 *   - 403 authenticated but not permitted (reserved for the operation layer)
 *   - 404 resource not found / membership absent (do NOT reveal existence)
 *   - 429 rate limit exhausted
 */
export class AuthError extends HubError {
  readonly status: 400 | 401 | 403 | 404 | 429;

  constructor(status: 400 | 401 | 403 | 404 | 429, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Thrown by the invite-redeem path when a code cannot be redeemed because it is
 * invalid, revoked, expired, or used up — i.e. it will NEVER work again. Maps to
 * HTTP 410 Gone (the UI renders it as "this invite has expired or been used up").
 *
 * SECURITY: every redeem-failure reason collapses to this ONE status + generic
 * message on purpose. The public redeem route must not let a caller distinguish
 * "no such code" from "revoked" / "expired" / "exhausted" — that distinction
 * would turn the route into an oracle for enumerating which codes ever existed
 * (the redeem throttle defends the rate; this defends the signal). Unlike an
 * auth failure (401/403), the credential here is valid — only the code is not.
 */
export class InviteError extends HubError {
  readonly status = 410 as const;
}

/**
 * Thrown by a management operation when the request is well-formed and the caller
 * is authorized, but the action would violate an invariant the workspace must keep
 * — specifically, removing or demoting the LAST admin (a workspace must always
 * retain at least one). Maps to HTTP 409 Conflict.
 *
 * Unlike AuthError (whose internal `message` is hidden behind a status-keyed
 * generic reply), a ConflictError's `message` IS user-facing actionable guidance
 * (e.g. "promote another admin first") and the route layer echoes it verbatim,
 * the way it does for ValidationError. There is no existence-leak concern here:
 * the caller is already an admin of this workspace and can list its members.
 */
export class ConflictError extends HubError {
  readonly status = 409 as const;
}

/**
 * Thrown when a request is well-formed and the caller is authorized, but the
 * action requires a deployment feature this server was never configured for
 * (e.g. email invites without RESEND_API_KEY). Maps to HTTP 501 Not
 * Implemented. `message` is user-facing (like ConflictError) — no
 * existence-leak concern, the caller is already an authenticated admin.
 */
export class NotConfiguredError extends HubError {
  readonly status = 501 as const;
}
