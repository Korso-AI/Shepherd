import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { WorkspaceSummaryT } from "@shepherd/shared";
import { useShepherdClient } from "./context.js";
import { describeError } from "./client.js";

// ---------------------------------------------------------------------------
// JoinWorkspace — the invite-link landing surface (`/shepherd/join/:code`).
//
// Clicking an invite link IS the join intent, so the component redeems the code
// as soon as it mounts — no extra confirm click — and hands the joined
// workspace to the host via `onJoined` so it can navigate to the board. Redeem
// is idempotent for an existing member (the hub answers success without burning
// a use), so a stray re-mount or a user re-clicking the email link is safe.
//
// The invite code is a bearer-style capability: possession is the only gate.
// The joining identity always comes from the host's authenticated client
// transport (the BFF's trusted x-account-id), never from the code.
// ---------------------------------------------------------------------------

export interface JoinWorkspaceProps {
  /** The raw invite code from the URL segment, forwarded opaquely to the hub. */
  code: string;
  /**
   * Invoked once the redeem succeeds, with the workspace just joined. The host
   * navigates to its board surface; the component keeps showing the success
   * state until that navigation lands.
   */
  onJoined: (workspace: WorkspaceSummaryT) => void;
}

type JoinState =
  | { status: "joining" }
  | { status: "joined"; workspace: WorkspaceSummaryT }
  | { status: "error"; message: string };

export function JoinWorkspace({ code, onJoined }: JoinWorkspaceProps) {
  const client = useShepherdClient();
  const headingId = useId();

  const [state, setState] = useState<JoinState>({ status: "joining" });

  // Keep the latest onJoined without re-triggering the mount redeem when a
  // host passes a fresh callback identity each render.
  const onJoinedRef = useRef(onJoined);
  onJoinedRef.current = onJoined;

  const redeem = useCallback(async () => {
    setState({ status: "joining" });
    try {
      const res = await client.redeemInvite(code);
      setState({ status: "joined", workspace: res.workspace });
      onJoinedRef.current(res.workspace);
    } catch (err: unknown) {
      setState({ status: "error", message: describeError(err) });
    }
  }, [client, code]);

  // Redeem once on mount. The ref guard keeps StrictMode's dev double-mount
  // (which preserves refs across the simulated remount) from firing twice.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void redeem();
  }, [redeem]);

  return (
    <section className="shepherd-join" aria-labelledby={headingId}>
      <div className="shepherd-join__card">
        <p className="shepherd-join__brand">Shepherd</p>

        {state.status === "joining" && (
          <>
            <h1 id={headingId}>Joining workspace…</h1>
            <p className="shepherd-join__copy" role="status">
              Hold on while we add you to the team.
            </p>
            <div className="shepherd-join__spinner" aria-hidden="true" />
          </>
        )}

        {state.status === "joined" && (
          <>
            <h1 id={headingId}>You&rsquo;re in</h1>
            <p className="shepherd-join__copy" role="status">
              Joined <strong>{state.workspace.name}</strong>. Taking you to the
              board…
            </p>
          </>
        )}

        {state.status === "error" && (
          <>
            <h1 id={headingId}>Couldn&rsquo;t join the workspace</h1>
            <p className="shepherd-join__error" role="alert">
              {state.message}
            </p>
            <button
              type="button"
              className="shepherd-join__retry"
              onClick={() => void redeem()}
            >
              Try again
            </button>
          </>
        )}
      </div>
    </section>
  );
}
