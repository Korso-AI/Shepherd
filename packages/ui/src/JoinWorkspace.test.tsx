import { describe, it, expect, vi, beforeEach } from "vitest";
import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ShepherdClientProvider } from "./context.js";
import { JoinWorkspace } from "./JoinWorkspace.js";
import { ShepherdClientError } from "./client.js";
import { makeMockClient } from "./test/mockClient.js";
import type { WorkspaceSummaryT } from "@shepherd/shared";

// ---------------------------------------------------------------------------
// JoinWorkspace — the invite-link landing surface. Redeems the code as soon as
// it mounts (clicking the link IS the intent; no extra confirm click), then
// hands the joined workspace to the host via onJoined so it can navigate.
// ---------------------------------------------------------------------------

const WS: WorkspaceSummaryT = {
  id: "ws_1",
  slug: "acme",
  name: "Acme",
  role: "member",
};

describe("JoinWorkspace", () => {
  let client: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    client = makeMockClient();
    client.redeemInvite.mockResolvedValue({ workspace: WS });
  });

  function renderJoin(onJoined = vi.fn()) {
    render(
      <ShepherdClientProvider client={client}>
        <JoinWorkspace code="invitecode01" onJoined={onJoined} />
      </ShepherdClientProvider>,
    );
    return onJoined;
  }

  it("redeems the code on mount and reports the joined workspace", async () => {
    const onJoined = renderJoin();
    await waitFor(() => expect(onJoined).toHaveBeenCalledWith(WS));
    expect(client.redeemInvite).toHaveBeenCalledWith("invitecode01");
    // The success state names the workspace while the host navigates away.
    expect(screen.getByText(/acme/i)).toBeInTheDocument();
  });

  it("shows a joining state while the redeem is in flight", async () => {
    let resolve!: (v: { workspace: WorkspaceSummaryT }) => void;
    client.redeemInvite.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const onJoined = renderJoin();
    expect(screen.getByText(/joining workspace/i)).toBeInTheDocument();
    expect(onJoined).not.toHaveBeenCalled();
    resolve({ workspace: WS });
    await waitFor(() => expect(onJoined).toHaveBeenCalledWith(WS));
  });

  it("redeems exactly once under StrictMode's double-mount", async () => {
    const onJoined = vi.fn();
    render(
      <StrictMode>
        <ShepherdClientProvider client={client}>
          <JoinWorkspace code="invitecode01" onJoined={onJoined} />
        </ShepherdClientProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(onJoined).toHaveBeenCalled());
    expect(client.redeemInvite).toHaveBeenCalledTimes(1);
  });

  it("surfaces a redeem failure as an alert with the hub's message and offers a retry", async () => {
    client.redeemInvite.mockRejectedValueOnce(
      new ShepherdClientError(
        "HTTP 410: Invite expired or no longer valid",
        410,
      ),
    );
    const onJoined = renderJoin();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/invite expired/i);
    expect(onJoined).not.toHaveBeenCalled();

    // Retry re-runs the redeem; the default mock now succeeds.
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(onJoined).toHaveBeenCalledWith(WS));
    expect(client.redeemInvite).toHaveBeenCalledTimes(2);
  });

  it("degrades a non-Error rejection to a generic message", async () => {
    client.redeemInvite.mockRejectedValueOnce("nope");
    renderJoin();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/something went wrong/i);
  });
});
