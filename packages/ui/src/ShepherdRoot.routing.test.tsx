import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ShepherdClientProvider } from "./context.js";
import { ShepherdRoot } from "./ShepherdRoot.js";
import { makeMockClient } from "./test/mockClient.js";

// ---------------------------------------------------------------------------
// ShepherdRoot — routing / landing + empty-state gating on the flat tab strip.
//
// Landing keys off listWorkspaces() being empty (decided once, on the first
// resolved list, inside <Dashboard> from `hasWorkspace`):
//   - no workspace  → land on Tasks showing the first-run setup checklist; the
//     board never polls (nothing to scope to) and Chat renders an EmptyState.
//   - >= 1 workspace → land on Tasks for the first (selected) workspace, which
//     the board polls via the workspace-scoped landscape(id) route.
// ---------------------------------------------------------------------------

const WS = { id: "ws_1", slug: "acme", name: "Acme", role: "admin" as const };
const WS2 = { id: "ws_2", slug: "beta", name: "Beta", role: "admin" as const };

describe("ShepherdRoot routing / landing", () => {
  let client: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    // Dashboard persists the active tab; clear it so a prior test's pick never
    // leaks into the next test's landing decision.
    localStorage.clear();
    client = makeMockClient();
  });

  function renderRoot(rootProps: { onLogout?: () => void } = {}) {
    return render(
      <ShepherdClientProvider client={client}>
        <ShepherdRoot hubUrl="https://hub.example.run.app" {...rootProps} />
      </ShepherdClientProvider>,
    );
  }

  it("lands on Tasks when the account has at least one workspace", async () => {
    client.listWorkspaces = vi.fn().mockResolvedValue({ workspaces: [WS] });
    renderRoot();

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Tasks" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
  });

  it("scopes the board to the selected workspaceId", async () => {
    client.listWorkspaces = vi.fn().mockResolvedValue({ workspaces: [WS] });
    renderRoot();

    // Dashboard's polling hook hits the workspace-scoped landscape(id) route.
    await waitFor(() => expect(client.landscape).toHaveBeenCalledWith("ws_1"));
  });

  it("lands on Tasks with the setup checklist when the account has no workspace", async () => {
    // Behavior change (Task 4): the no-workspace account now lands on Tasks so
    // the first-run setup checklist is the first thing a new operator sees,
    // rather than landing on Settings.
    client.listWorkspaces = vi.fn().mockResolvedValue({ workspaces: [] });
    renderRoot();

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Tasks" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(
      screen.getByRole("region", { name: /setup guide/i }),
    ).toBeInTheDocument();
  });

  it("renders hosted sign out on the no-workspace Settings prompt without polling", async () => {
    const onLogout = vi.fn();
    client.listWorkspaces = vi.fn().mockResolvedValue({ workspaces: [] });
    renderRoot({ onLogout });

    // Now lands on Tasks (the setup checklist); Settings stays reachable via
    // its tab, where the "not in a workspace" prompt + sign out live.
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Tasks" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    await userEvent.click(screen.getByRole("tab", { name: "Settings" }));

    expect(screen.getByText(/not in a workspace yet/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /sign out/i }));

    expect(onLogout).toHaveBeenCalledTimes(1);
    // Invariant preserved: a no-workspace shell never polls the landscape.
    expect(client.landscape).not.toHaveBeenCalled();
    expect(client.getLandscape).not.toHaveBeenCalled();
  });

  it("shows the setup checklist (not an error) on Tasks when there is no workspace", async () => {
    // Behavior change (Task 4): Tasks now renders the setup checklist for a
    // no-workspace account, replacing the old "No workspace yet" EmptyState.
    client.listWorkspaces = vi.fn().mockResolvedValue({ workspaces: [] });
    renderRoot();

    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: /setup guide/i }),
      ).toBeInTheDocument(),
    );

    // The board never polled, since there is no workspace.
    expect(client.landscape).not.toHaveBeenCalled();
    expect(client.getLandscape).not.toHaveBeenCalled();
  });

  it("create step: generating a token refetches, auto-selects the new workspace, and reaches the connect stage", async () => {
    // Plan Task 5 integration: a no-workspace root → checklist create step
    // generates a token (which creates the workspace in one action) →
    // listWorkspaces refetched → the new workspace auto-selected and polled →
    // the checklist advances to the connect stage.
    let list: (typeof WS)[] = [];
    client.listWorkspaces = vi
      .fn()
      .mockImplementation(async () => ({ workspaces: list }));
    client.createWorkspace = vi.fn().mockImplementation(async () => {
      list = [WS];
      return WS;
    });
    renderRoot();

    // No workspace → the create-step checklist on Tasks.
    await screen.findByRole("region", { name: /setup guide/i });
    await userEvent.type(screen.getByLabelText(/workspace name/i), "Acme");
    await userEvent.click(
      screen.getByRole("button", { name: /generate token/i }),
    );

    // The create triggers a refetch; the new workspace becomes selected and the
    // board polls it via the workspace-scoped route.
    await waitFor(() => expect(client.landscape).toHaveBeenCalledWith("ws_1"));
    // Connect stage: step 1's create form is gone (replaced by the checked
    // workspace summary) and step 2 waits for the first agent.
    await waitFor(() =>
      expect(
        screen.queryByLabelText(/workspace name/i),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByText(/waiting for your agent to check in/i),
    ).toBeInTheDocument();
    // ONE click did it all: the token minted by that same click is still in
    // the install command after the switch onto the new workspace — the guide
    // never unmounted mid-flow (a remount would eat the token and force a
    // second "Generate token" click).
    expect(client.mintAccountToken).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("setup-install-command").textContent).toContain(
      "shp_mock",
    );
  });

  it("shows a loading indicator before the workspace list resolves", async () => {
    let resolve!: (v: { workspaces: (typeof WS)[] }) => void;
    client.listWorkspaces = vi.fn().mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    renderRoot();

    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);

    resolve({ workspaces: [WS] });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Tasks" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
  });

  it("shows the error alert (not a crash) when listWorkspaces fails", async () => {
    client.listWorkspaces = vi.fn().mockRejectedValue(new Error("boom"));
    renderRoot();

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });

  it("switches the active board via the app-bar workspace switcher", async () => {
    client.listWorkspaces = vi
      .fn()
      .mockResolvedValue({ workspaces: [WS, WS2] });
    renderRoot();

    // Lands on Tasks for the first workspace.
    await waitFor(() => expect(client.landscape).toHaveBeenCalledWith("ws_1"));

    // The switcher rides in the header on every tab: open it and pick the other
    // workspace (WS = "Acme", WS2 = "Beta").
    await userEvent.click(screen.getByRole("button", { name: /acme/i }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: /beta/i }));

    // The Dashboard now polls the newly-selected workspace.
    await waitFor(() => expect(client.landscape).toHaveBeenCalledWith("ws_2"));
  });

  it("creating a workspace via the switcher selects it and stays on the current tab", async () => {
    // A dynamic list so the re-list after create includes the new workspace —
    // ShepherdRoot preserves a still-present selection across the re-list.
    let list = [WS, WS2];
    client.listWorkspaces = vi
      .fn()
      .mockImplementation(async () => ({ workspaces: list }));
    client.createWorkspace = vi.fn().mockImplementation(async () => {
      const ws = {
        id: "ws_new",
        slug: "gamma",
        name: "Gamma",
        role: "admin" as const,
      };
      list = [...list, ws];
      return ws;
    });
    renderRoot();

    await waitFor(() => expect(client.landscape).toHaveBeenCalledWith("ws_1"));

    // Go to Settings, then create a workspace through the switcher's menu.
    await userEvent.click(screen.getByRole("tab", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: /acme/i }));
    await userEvent.click(
      screen.getByRole("menuitem", { name: /create workspace/i }),
    );
    await userEvent.type(screen.getByLabelText(/new workspace name/i), "Gamma");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));

    // The new workspace becomes active (its name shows on the trigger) and the
    // create never re-lands us off Settings.
    await waitFor(() => expect(client.createWorkspace).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /gamma/i }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
