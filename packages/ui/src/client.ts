import {
  ListWorkspacesResponse,
  CreateWorkspaceResponse,
  DeleteWorkspaceResponse,
  DeleteAccountResponse,
  MintTokenResponse,
  ListTokensResponse,
  InviteResponse,
  InviteByEmailResponse,
  ListEmailInvitesResponse,
  RedeemInviteResponse,
  ListMembersResponse,
  WorkspaceLandscapeResponse,
  WorkspaceAnnounceResponse,
  FeedbackResponse,
} from "@shepherd/shared";
import type { ZodType } from "zod";
import type {
  ListWorkspacesResponseT,
  CreateWorkspaceRequestT,
  CreateWorkspaceResponseT,
  DeleteWorkspaceResponseT,
  DeleteAccountResponseT,
  MintTokenRequestT,
  MintTokenResponseT,
  ListTokensResponseT,
  CreateInviteRequestT,
  InviteResponseT,
  InviteByEmailResponseT,
  ListEmailInvitesResponseT,
  RedeemInviteResponseT,
  ListMembersResponseT,
  WorkspaceLandscapeResponseT,
  WorkspaceAnnounceRequestT,
  WorkspaceAnnounceResponseT,
  FeedbackRequestT,
  FeedbackResponseT,
} from "@shepherd/shared";

/** Per-request abort fires after this many ms when no timeoutMs is configured. */
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * The single error type surfaced by the client. A missing `status` means a
 * transport failure (network error or request timeout); a present `status` is
 * the upstream HTTP status of a non-2xx response. One class — distinguished by
 * the optional `status` — keeps callers from having to branch on two error
 * types just to tell "couldn't reach the hub" from "the hub said no".
 */
export class ShepherdClientError extends Error {
  /** Upstream HTTP status for a non-2xx response; absent for transport errors. */
  readonly status?: number;

  /**
   * @param message - Human-readable failure description.
   * @param status - Upstream HTTP status, omitted for network/abort failures.
   */
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ShepherdClientError";
    if (status !== undefined) {
      this.status = status;
    }
  }
}

/**
 * Maps any thrown value into a short, human-friendly message for the view layer.
 * A {@link ShepherdClientError} (and any other `Error`) surfaces its own
 * `message` — which already carries the hub's detail for non-2xx responses and a
 * transport description otherwise — while a non-Error value degrades to a
 * generic line rather than stringifying something unprintable.
 *
 * @param err - The caught value (typically from a client method rejection).
 * @returns A display-ready message string.
 */
export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}

/**
 * The typed Shepherd hub surface. The plural, workspace-scoped methods use the
 * `/workspaces/:id/...` form (which works in both deployments: a bearer token
 * resolves its own workspace and ignores `:id`, while a browser session
 * validates membership of `:id`). The singular `getLandscape()`/`announce()`
 * pair are the self-host aliases against the implicit single-workspace routes.
 * Every response with a dedicated schema is Zod-parsed at the boundary so a
 * contract drift throws `Invalid response schema` rather than flowing a
 * malformed object into the view layer.
 */
export interface ShepherdClient {
  /** The normalised (trailing-slash-stripped) hub base URL the client targets. */
  readonly baseUrl: string;

  // --- multi-workspace management surface ---------------------------------
  /** GET the caller's workspaces, each tagged with the caller's role. */
  listWorkspaces(): Promise<ListWorkspacesResponseT>;
  /** POST a new workspace; the caller becomes its admin. */
  createWorkspace(body: CreateWorkspaceRequestT): Promise<CreateWorkspaceResponseT>;
  /** DELETE a workspace and ALL its data (admin only). Permanent, irreversible. */
  deleteWorkspace(workspaceId: string): Promise<DeleteWorkspaceResponseT>;
  /**
   * DELETE the caller's own account: leaves every workspace (deleting those
   * where the caller was the sole member), revokes every token, and erases the
   * profile. 409s when the caller is the last admin of a workspace that still
   * has other members. Permanent, irreversible.
   */
  deleteAccount(): Promise<DeleteAccountResponseT>;

  /** POST a new agent token; the raw `shp_` value is returned exactly once. */
  mintToken(workspaceId: string, body: MintTokenRequestT): Promise<MintTokenResponseT>;
  /** GET the workspace's token metadata (never the raw token). */
  listTokens(workspaceId: string): Promise<ListTokensResponseT>;
  /** DELETE (revoke) a token by id. */
  revokeToken(workspaceId: string, tokenId: string): Promise<void>;

  /** POST a new account-scoped agent token; the raw `shp_` value is returned exactly once. */
  mintAccountToken(body: MintTokenRequestT): Promise<MintTokenResponseT>;
  /** GET the caller's account-scoped token metadata (never the raw token). */
  listAccountTokens(): Promise<ListTokensResponseT>;
  /** DELETE (revoke) an account-scoped token by id. */
  revokeAccountToken(id: string): Promise<void>;

  /** POST a new invite code for the workspace (admin only). */
  createInvite(workspaceId: string, body: CreateInviteRequestT): Promise<InviteResponseT>;
  /** POST a one-time-use invite emailed directly to an address (admin only). */
  inviteByEmail(workspaceId: string, email: string): Promise<InviteByEmailResponseT>;
  /** GET the workspace's PENDING email invites (sent, not yet redeemed). Admin only. */
  listEmailInvites(workspaceId: string): Promise<ListEmailInvitesResponseT>;
  /** POST to revoke an invite code (admin only). */
  revokeInvite(workspaceId: string, code: string): Promise<void>;
  /** POST to redeem an invite code, joining its workspace as a member. */
  redeemInvite(code: string): Promise<RedeemInviteResponseT>;

  /** GET the workspace's member roster. */
  listMembers(workspaceId: string): Promise<ListMembersResponseT>;
  /** DELETE (remove) a member by account id (admin only). */
  removeMember(workspaceId: string, accountId: string): Promise<void>;
  /** POST to leave the workspace. */
  leave(workspaceId: string): Promise<void>;

  /** GET a specific workspace's landscape (agents, tasks, announcements). */
  landscape(workspaceId: string): Promise<WorkspaceLandscapeResponseT>;
  /** POST an operator announcement to a specific workspace. */
  announceTo(
    workspaceId: string,
    body: WorkspaceAnnounceRequestT,
  ): Promise<WorkspaceAnnounceResponseT>;

  /**
   * POST a bug/suggestion/other note from the feedback widget. Hits
   * `/workspaces/:id/feedback` when `workspaceId` is given (the normal hosted
   * case — a validated workspace to attach), or the flat `/feedback` otherwise
   * (self-host, or a hosted caller with no workspace selected yet).
   */
  submitFeedback(body: FeedbackRequestT, workspaceId?: string): Promise<FeedbackResponseT>;

  // --- self-host singular aliases (implicit single workspace) -------------
  /** GET the unfiltered whole-workspace view (agents, tasks, announcements). */
  getLandscape(): Promise<WorkspaceLandscapeResponseT>;
  /** POST an operator announcement (broadcast or @targeted) to the workspace. */
  announce(req: WorkspaceAnnounceRequestT): Promise<WorkspaceAnnounceResponseT>;
}

/**
 * Construction options for {@link createShepherdClient}. Auth is supplied
 * externally via `getAuthHeader` so the core client stays auth-agnostic — it
 * never reads tokens, localStorage, or a BFF; it only merges whatever the host
 * injects and notifies the host on a 401 via `onUnauthorized`.
 */
export interface ShepherdClientConfig {
  /** Hub origin; a trailing slash is tolerated and normalised away. "" = same-origin. */
  baseUrl: string;
  /**
   * Returns the credential for the next request, as either:
   *   - a string  → sent as the `Authorization` header value (e.g. "Bearer …"),
   *   - a header map → merged verbatim over the JSON content-type base, or
   *   - undefined  → no auth header added (same-origin BFF supplies the cookie).
   * May be sync or async (e.g. refreshing a short-lived token). Omit entirely
   * for an unauthenticated/same-origin deployment.
   */
  getAuthHeader?: () =>
    | string
    | Record<string, string>
    | undefined
    | Promise<string | Record<string, string> | undefined>;
  /** Invoked once when the hub responds 401, before the error is thrown. */
  onUnauthorized?: () => void;
  /** Per-request abort timeout in ms; defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Reads a best-effort `{ error: string }` message from a non-2xx response body
 * so the thrown error carries the hub's own explanation. A non-JSON or bodyless
 * response degrades to an empty string — the status code is still informative.
 *
 * @param res - The non-2xx response to inspect.
 * @returns The upstream error string, or "" when none could be read.
 */
async function readErrorDetail(res: Response): Promise<string> {
  try {
    const data: unknown = await res.json();
    if (
      data !== null &&
      typeof data === "object" &&
      "error" in data &&
      typeof (data as { error: unknown }).error === "string"
    ) {
      return (data as { error: string }).error;
    }
  } catch {
    // Body wasn't JSON; the status code alone remains informative.
  }
  return "";
}

/**
 * Builds a browser fetch client for the Shepherd hub. Each call wires up an
 * AbortController timeout (cleared in `finally`), merges the injected auth
 * headers over a JSON content-type base, and Zod-parses ONLY the response at
 * the boundary — the request body is forwarded verbatim because the caller owns
 * its input shape. void-returning methods (revoke/remove/leave) await the
 * request and parse nothing.
 *
 * @param config - Base URL, optional injected auth, 401 hook, and timeout.
 * @returns A {@link ShepherdClient}.
 */
export function createShepherdClient(config: ShepherdClientConfig): ShepherdClient {
  // Strip a trailing slash so `${baseUrl}/workspace/...` never yields a double
  // slash regardless of how the host configured the origin. An empty baseUrl
  // stays "" so paths resolve root-relative (same-origin).
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const enc = encodeURIComponent;

  /**
   * Performs one request, mapping transport failures to a status-less error,
   * 401s to `onUnauthorized` + a 401 error, other non-2xx to a status error,
   * and a 2xx body either through the supplied Zod schema or — when no schema
   * is given (void endpoints) — to `undefined`.
   */
  async function request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; schema?: ZodType<T> } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      // Only advertise a JSON body when there actually IS one. A bodyless
      // POST/DELETE (leave, revoke, deleteWorkspace) that still sent
      // `Content-Type: application/json` made the hub's Fastify parser reject the
      // empty body (FST_ERR_CTP_EMPTY_JSON_BODY), which surfaced to the user as an
      // opaque HTTP 500. Omitting the header on bodyless calls lets the request
      // reach the route handler instead of dying in body parsing.
      const baseHeaders: Record<string, string> =
        opts.body !== undefined ? { "Content-Type": "application/json" } : {};
      // Resolve getAuthHeader (sync or async) into a header record: a string is
      // the Authorization value, a map merges verbatim, undefined adds nothing.
      // Injected auth wins over the base, so a host may even override the
      // content-type if it ever needs to. Built INSIDE the try so a rejecting
      // (async) getAuthHeader is funneled through the catch and the finally
      // still clears the abort timer — no leaked timer on an auth failure.
      const resolved = await config.getAuthHeader?.();
      const authHeaders: Record<string, string> =
        typeof resolved === "string"
          ? { Authorization: resolved }
          : resolved ?? {};
      const init: RequestInit = {
        method,
        headers: { ...baseHeaders, ...authHeaders },
        signal: controller.signal,
      };
      if (opts.body !== undefined) {
        init.body = JSON.stringify(opts.body);
      }
      res = await fetch(`${baseUrl}${path}`, init);
    } catch (err) {
      // Network error or abort/timeout: no HTTP status exists, so the error is
      // thrown WITHOUT one to mark it a transport failure.
      throw new ShepherdClientError(
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401) {
      config.onUnauthorized?.();
      throw new ShepherdClientError("Unauthorized", 401);
    }

    if (!res.ok) {
      const detail = await readErrorDetail(res);
      throw new ShepherdClientError(
        detail !== ""
          ? `HTTP ${res.status}: ${detail}`
          : `HTTP ${res.status}`,
        res.status,
      );
    }

    if (!opts.schema) {
      // void endpoint: no dedicated response schema. Drain any body and resolve
      // undefined — callers of these methods don't depend on the payload.
      try {
        await res.json();
      } catch {
        // empty / non-JSON body is fine for a void endpoint.
      }
      // void endpoints are called as request<void>(...); the undefined resolve
      // is the intended value, asserted to T since the no-schema branch is only
      // reached for the void-typed callers.
      return undefined as T;
    }

    const parsed = opts.schema.safeParse(await res.json());
    if (!parsed.success) {
      throw new ShepherdClientError("Invalid response schema");
    }
    return parsed.data;
  }

  return {
    baseUrl,

    // --- multi-workspace management surface ---------------------------------
    listWorkspaces(): Promise<ListWorkspacesResponseT> {
      return request("GET", "/workspaces", {
        schema: ListWorkspacesResponse,
      });
    },
    createWorkspace(body: CreateWorkspaceRequestT): Promise<CreateWorkspaceResponseT> {
      return request("POST", "/workspaces", {
        body,
        schema: CreateWorkspaceResponse,
      });
    },
    deleteWorkspace(workspaceId: string): Promise<DeleteWorkspaceResponseT> {
      return request("DELETE", `/workspaces/${enc(workspaceId)}`, {
        schema: DeleteWorkspaceResponse,
      });
    },
    deleteAccount(): Promise<DeleteAccountResponseT> {
      return request("DELETE", "/account", {
        schema: DeleteAccountResponse,
      });
    },

    mintToken(workspaceId: string, body: MintTokenRequestT): Promise<MintTokenResponseT> {
      return request("POST", `/workspaces/${enc(workspaceId)}/tokens`, {
        body,
        schema: MintTokenResponse,
      });
    },
    listTokens(workspaceId: string): Promise<ListTokensResponseT> {
      return request("GET", `/workspaces/${enc(workspaceId)}/tokens`, {
        schema: ListTokensResponse,
      });
    },
    revokeToken(workspaceId: string, tokenId: string): Promise<void> {
      return request<void>(
        "DELETE",
        `/workspaces/${enc(workspaceId)}/tokens/${enc(tokenId)}`,
      );
    },

    mintAccountToken(body: MintTokenRequestT): Promise<MintTokenResponseT> {
      return request("POST", "/tokens", {
        body,
        schema: MintTokenResponse,
      });
    },
    listAccountTokens(): Promise<ListTokensResponseT> {
      return request("GET", "/tokens", {
        schema: ListTokensResponse,
      });
    },
    revokeAccountToken(id: string): Promise<void> {
      return request<void>("DELETE", `/tokens/${enc(id)}`);
    },

    createInvite(workspaceId: string, body: CreateInviteRequestT): Promise<InviteResponseT> {
      return request("POST", `/workspaces/${enc(workspaceId)}/invites`, {
        body,
        schema: InviteResponse,
      });
    },
    inviteByEmail(workspaceId: string, email: string): Promise<InviteByEmailResponseT> {
      return request("POST", `/workspaces/${enc(workspaceId)}/invites/email`, {
        body: { email },
        schema: InviteByEmailResponse,
      });
    },
    listEmailInvites(workspaceId: string): Promise<ListEmailInvitesResponseT> {
      return request("GET", `/workspaces/${enc(workspaceId)}/invites/email`, {
        schema: ListEmailInvitesResponse,
      });
    },
    revokeInvite(workspaceId: string, code: string): Promise<void> {
      return request<void>(
        "POST",
        `/workspaces/${enc(workspaceId)}/invites/${enc(code)}/revoke`,
      );
    },
    redeemInvite(code: string): Promise<RedeemInviteResponseT> {
      return request("POST", `/invites/${enc(code)}/redeem`, {
        schema: RedeemInviteResponse,
      });
    },

    listMembers(workspaceId: string): Promise<ListMembersResponseT> {
      return request("GET", `/workspaces/${enc(workspaceId)}/members`, {
        schema: ListMembersResponse,
      });
    },
    removeMember(workspaceId: string, accountId: string): Promise<void> {
      return request<void>(
        "DELETE",
        `/workspaces/${enc(workspaceId)}/members/${enc(accountId)}`,
      );
    },
    leave(workspaceId: string): Promise<void> {
      return request<void>("POST", `/workspaces/${enc(workspaceId)}/leave`);
    },

    landscape(workspaceId: string): Promise<WorkspaceLandscapeResponseT> {
      // WorkspaceLandscapeResponse's inferred type widens the announcement
      // admin flags to optional, so it doesn't structurally match the declared
      // ...ResponseT alias; an explicit cast is kept for just this schema.
      return request("GET", `/workspaces/${enc(workspaceId)}/landscape`, {
        schema: WorkspaceLandscapeResponse,
      }) as Promise<WorkspaceLandscapeResponseT>;
    },
    announceTo(
      workspaceId: string,
      body: WorkspaceAnnounceRequestT,
    ): Promise<WorkspaceAnnounceResponseT> {
      // The request body is NOT validated here — the caller owns input shape;
      // only the RESPONSE is parsed at the boundary.
      return request("POST", `/workspaces/${enc(workspaceId)}/announce`, {
        body,
        schema: WorkspaceAnnounceResponse,
      });
    },

    submitFeedback(body: FeedbackRequestT, workspaceId?: string): Promise<FeedbackResponseT> {
      const path = workspaceId !== undefined
        ? `/workspaces/${enc(workspaceId)}/feedback`
        : "/feedback";
      return request("POST", path, { body, schema: FeedbackResponse });
    },

    // --- self-host singular aliases (implicit single workspace) -------------
    getLandscape(): Promise<WorkspaceLandscapeResponseT> {
      // See landscape() above: this schema's inferred type doesn't structurally
      // match the ...ResponseT alias, so its explicit cast is kept.
      return request("GET", "/workspace/landscape", {
        schema: WorkspaceLandscapeResponse,
      }) as Promise<WorkspaceLandscapeResponseT>;
    },
    announce(req: WorkspaceAnnounceRequestT): Promise<WorkspaceAnnounceResponseT> {
      // The request body is NOT validated here — the caller owns input shape;
      // only the RESPONSE is parsed at the boundary.
      return request("POST", "/workspace/announce", {
        body: req,
        schema: WorkspaceAnnounceResponse,
      });
    },
  };
}
