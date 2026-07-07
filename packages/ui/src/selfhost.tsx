import { useCallback, useMemo, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { createShepherdClient } from "./client.js";
import { ShepherdClientProvider } from "./context.js";
import { Dashboard } from "./components/Dashboard.js";

/**
 * localStorage key the operator's team token is stored under. Kept identical to
 * the legacy vanilla board (packages/hub/public/app.js's `TOKEN_KEY`) so a
 * viewer who already authenticated against the old board stays signed in after
 * the React cutover — no re-prompt on upgrade.
 */
const TOKEN_KEY = "shepherd.token";

/** localStorage read that never throws (private/quota modes return null). */
function readToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * The token gate, ported from the `.gate` markup in packages/hub/public/index.html.
 * Rendered whenever no token is stored; submitting a non-empty token persists it
 * and lifts the gate via {@link onSubmit}.
 *
 * @param props.onSubmit - Called with the entered token once the form is submitted.
 */
function Gate({
  onSubmit,
}: {
  onSubmit: (token: string) => void;
}): ReactElement {
  const [value, setValue] = useState("");

  const handle = (e: FormEvent): void => {
    e.preventDefault();
    const trimmed = value.trim();
    // Ignore an empty submit so the gate can't store a blank token and then
    // bounce the viewer straight back to itself on the first 401.
    if (trimmed !== "") onSubmit(trimmed);
  };

  return (
    <section id="gate" className="gate">
      <h1>Shepherd</h1>
      <p>Enter the team token to view the workspace.</p>
      <form id="gate-form" onSubmit={handle}>
        <input
          id="gate-input"
          type="password"
          placeholder="Team token"
          aria-label="Team token"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit">View</button>
      </form>
    </section>
  );
}

/**
 * The self-host SPA root and the ONE place a team token is handled — the named
 * auth exception to the auth-agnostic core. Everything below the provider (the
 * client, the polling hook, the {@link Dashboard}) stays token-blind; this
 * component owns the token's lifecycle:
 *
 *  - It seeds token state from `localStorage["shepherd.token"]` (back-compat with
 *    the legacy board), so a returning viewer skips the gate.
 *  - With NO token it renders the {@link Gate}; a successful submit persists the
 *    token and re-renders into the dashboard.
 *  - With a token it builds a same-origin client (`baseUrl: ""`) that injects the
 *    `Authorization: Bearer <token>` header and, on a 401, clears the stored
 *    token and resets state — which re-renders straight back to the gate. This is
 *    the React analogue of app.js's `clearToken()` + re-prompt 401 flow.
 *
 * The client is memoised on the token so it is rebuilt only when the token
 * actually changes, not on every freshness re-render of the dashboard subtree.
 *
 * @returns Either the token gate or the authenticated dashboard.
 */
export function SelfHostApp(): ReactElement {
  const [token, setToken] = useState<string>(readToken);

  const clearToken = useCallback((): void => {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      // Best-effort: even if the remove fails, resetting state below still
      // returns the viewer to the gate for this session.
    }
    setToken("");
  }, []);

  // Rebuild the client only when the token changes. WHY same-origin (baseUrl
  // ""): the hub serves this SPA, so requests hit the hub's own origin and need
  // no cross-origin base. onUnauthorized clears the token + resets state, which
  // re-renders back to the gate — the automatic 401 re-gate.
  const client = useMemo(
    () =>
      createShepherdClient({
        baseUrl: "",
        getAuthHeader: () => `Bearer ${token}`,
        onUnauthorized: clearToken,
      }),
    [clearToken, token],
  );

  if (token === "") {
    return (
      <Gate
        onSubmit={(t) => {
          try {
            localStorage.setItem(TOKEN_KEY, t);
          } catch {
            // Best-effort persistence; the in-memory token still authenticates
            // this session even if storage is unavailable.
          }
          setToken(t);
        }}
      />
    );
  }

  // Restore the legacy board's layout container: the ported styles size `.wrap`
  // to max-width:1100px with page gutters. The gate centers itself (`.gate`), so
  // only the dashboard view needs the wrapper.
  return (
    <div className="wrap">
      <ShepherdClientProvider client={client}>
        <Dashboard onLogout={clearToken} />
      </ShepherdClientProvider>
    </div>
  );
}
