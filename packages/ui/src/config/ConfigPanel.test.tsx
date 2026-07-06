import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { ShepherdClientProvider } from "../context.js";
import { ConfigPanel } from "./ConfigPanel.js";
import { makeMockClient } from "../test/mockClient.js";
import type { WorkspaceSummaryT } from "@shepherd/shared";

// ---------------------------------------------------------------------------
// ConfigPanel — the Config tab body: a left nav (Workspace · Members · Agent ·
// Account) beside the active section's panel. Workspace is the default; Members
// shows the roster plus (admin-only) Invites; Agent shows the connect flow;
// Account holds the account-level Sign out / Delete account actions (split out
// of the Workspace tab).
// ---------------------------------------------------------------------------

const ADMIN_WS: WorkspaceSummaryT = {
  id: "ws_1",
  slug: "acme",
  name: "Acme",
  role: "admin",
  isOwner: true,
};
const MEMBER_WS: WorkspaceSummaryT = {
  id: "ws_2",
  slug: "beta",
  name: "Beta",
  role: "member",
  isOwner: false,
};

describe("ConfigPanel", () => {
  let client: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    client = makeMockClient();
  });

  function renderPanel(
    workspace: WorkspaceSummaryT = ADMIN_WS,
    props: Partial<Omit<ComponentProps<typeof ConfigPanel>, "workspace">> = {},
  ) {
    return render(
      <ShepherdClientProvider client={client}>
        <ConfigPanel workspace={workspace} {...props} />
      </ShepherdClientProvider>,
    );
  }

  it("defaults to the Workspace section", () => {
    renderPanel();
    expect(screen.getByRole("heading", { name: "Workspace" })).toBeInTheDocument();
    // Workspace shows the workspace name.
    expect(screen.getByText("Acme")).toBeInTheDocument();
  });

  it("renders Sign out on the Account tab when logout is supplied", async () => {
    const onLogout = vi.fn();
    renderPanel(ADMIN_WS, { onLogout });

    // Not on the default Workspace tab.
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(screen.getByText("Sign out of this Shepherd dashboard session.")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Sign out" });

    await userEvent.click(button);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("does not render account actions on the Workspace, Members or Agent sections", async () => {
    renderPanel(ADMIN_WS, { onLogout: vi.fn() });

    // Workspace (default) tab.
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete account" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Members" }));
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Agent" }));
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it("does not render the session sign out action without a logout callback", async () => {
    renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it("renders a Delete account field in the Account section", async () => {
    renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(screen.getByRole("button", { name: "Delete account" })).toBeInTheDocument();
  });

  it("switches to Members when its nav item is clicked", async () => {
    renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Members" }));
    expect(screen.getByRole("heading", { name: "Members" })).toBeInTheDocument();
  });

  it("switches to Agent when its nav item is clicked", async () => {
    renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Agent" }));
    expect(screen.getByRole("heading", { name: /connect your agent/i })).toBeInTheDocument();
  });

  it("shows Invites in the Members section for an admin", async () => {
    renderPanel(ADMIN_WS);
    await userEvent.click(screen.getByRole("button", { name: "Members" }));
    expect(screen.getByRole("button", { name: /create invite/i })).toBeInTheDocument();
  });

  it("hides Invites in the Members section for a non-admin member", async () => {
    renderPanel(MEMBER_WS);
    await userEvent.click(screen.getByRole("button", { name: "Members" }));
    expect(screen.queryByRole("button", { name: /create invite/i })).not.toBeInTheDocument();
  });

  it("marks the active nav item with aria-current", async () => {
    renderPanel();
    const workspace = screen.getByRole("button", { name: "Workspace" });
    expect(workspace).toHaveAttribute("aria-current", "page");

    await userEvent.click(screen.getByRole("button", { name: "Agent" }));
    expect(screen.getByRole("button", { name: "Agent" })).toHaveAttribute("aria-current", "page");
    expect(workspace).not.toHaveAttribute("aria-current");
  });
});
