const DEFAULT_TIMEOUT_MS = 5000;

/** Thrown when the hub is unreachable — network error or request timeout. */
export class HubUnreachable extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "HubUnreachable";
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/** Thrown when the hub responds with a non-2xx HTTP status. */
export class HubRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HubRequestError";
    this.status = status;
  }
}

export interface HubClient {
  post(path: string, body: unknown): Promise<unknown>;
  /**
   * Bodyless GET. Used by the `link` tool to fetch the account's
   * workspace memberships (`GET /workspaces`). Same error contract as `post`:
   * transport errors → HubUnreachable, non-2xx → HubRequestError.
   */
  get(path: string): Promise<unknown>;
}

/**
 * Factory that returns a hub HTTP client authenticated with the given bearer token.
 * The token is opaque to the client — it may be a hosted SHEPHERD_TOKEN or a
 * self-host TEAM_TOKEN; whichever is configured is sent as `Authorization: Bearer`.
 * Transport errors surface as HubUnreachable; non-2xx responses as HubRequestError.
 */
export function createHubClient({
  hubUrl,
  token,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  hubUrl: string;
  token: string;
  timeoutMs?: number;
}): HubClient {
  const baseUrl = hubUrl.replace(/\/$/, "");

  /**
   * Shared request core for post/get: applies the bearer auth, the abort
   * timeout, and the uniform error mapping (transport → HubUnreachable, non-2xx
   * → HubRequestError). `body` is omitted for GETs.
   */
  async function request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const message =
        err instanceof DOMException && err.name === "AbortError"
          ? `Hub request timed out after ${timeoutMs}ms (${path})`
          : `Hub unreachable at ${baseUrl}${path}: ${String(err)}`;
      throw new HubUnreachable(message, err);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // Surface the hub's own error message (e.g. "No live agent named …")
      // so the calling agent can self-correct instead of seeing a bare status
      // code. A non-JSON or bodyless response degrades to just the status.
      let detail = "";
      try {
        const data = (await response.json()) as unknown;
        if (
          data &&
          typeof data === "object" &&
          "error" in data &&
          typeof (data as { error: unknown }).error === "string"
        ) {
          detail = `: ${(data as { error: string }).error}`;
        }
      } catch {
        // Ignore — the body wasn't JSON; the status code is still informative.
      }
      throw new HubRequestError(
        response.status,
        `Hub returned HTTP ${response.status} for ${path}${detail}`,
      );
    }

    return response.json() as Promise<unknown>;
  }

  return {
    post(path: string, body: unknown): Promise<unknown> {
      return request("POST", path, body);
    },
    get(path: string): Promise<unknown> {
      return request("GET", path);
    },
  };
}
