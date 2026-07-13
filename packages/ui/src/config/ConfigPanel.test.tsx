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
    expect(
      screen.getByRole("heading", { name: "Workspace" }),
    ).toBeInTheDocument();
    // Workspace shows the workspace name.
    expect(screen.getByText("Acme")).toBeInTheDocument();
  });

  it("renders Sign out on the Account tab when logout is supplied", async () => {
    const onLogout = vi.fn();
    renderPanel(ADMIN_WS, { onLogout });

    // Not on the default Workspace tab.
    expect(
      screen.queryByRole("button", { name: "Sign out" }),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(
      screen.getByText("Sign out of this Shepherd dashboard session."),
    ).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Sign out" });

    await userEvent.click(button);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("does not render account actions on the Workspace, Members or Agent sections", async () => {
    renderPanel(ADMIN_WS, { onLogout: vi.fn() });

    // Workspace (default) tab.
    expect(
      screen.queryByRole("button", { name: "Sign out" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete account" }),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Members" }));
    expect(
      screen.queryByRole("button", { name: "Sign out" }),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Agent" }));
    expect(
      screen.queryByRole("button", { name: "Sign out" }),
    ).not.toBeInTheDocument();
  });

  it("does not render the session sign out action without a logout callback", async () => {
    renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(
      screen.queryByRole("button", { name: "Sign out" }),
    ).not.toBeInTheDocument();
  });

  it("renders a Delete account field in the Account section", async () => {
    renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(
      screen.getByRole("button", { name: "Delete account" }),
    ).toBeInTheDocument();
  });

  it("switches to Members when its nav item is clicked", async () => {
    renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Members" }));
    expect(
      screen.getByRole("heading", { name: "Members" }),
    ).toBeInTheDocument();
  });

  it("switches to Agent when its nav item is clicked", async () => {
    renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Agent" }));
    expect(
      screen.getByRole("heading", { name: /connect your agent/i }),
    ).toBeInTheDocument();
  });

  it("shows Invites in the Members section for an admin", async () => {
    renderPanel(ADMIN_WS);
    await userEvent.click(screen.getByRole("button", { name: "Members" }));
    expect(
      screen.getByRole("button", { name: /create invite/i }),
    ).toBeInTheDocument();
  });

  it("hides Invites in the Members section for a non-admin member", async () => {
    renderPanel(MEMBER_WS);
    await userEvent.click(screen.getByRole("button", { name: "Members" }));
    expect(
      screen.queryByRole("button", { name: /create invite/i }),
    ).not.toBeInTheDocument();
  });

  it("appends extra sections to the nav after the built-ins and renders them on click", async () => {
    renderPanel(ADMIN_WS, {
      extraSections: [
        {
          id: "usage",
          label: "Usage",
          render: ({ workspaceId }) => <p>Usage for {workspaceId}</p>,
        },
      ],
    });

    // The extra nav item comes AFTER every built-in.
    const items = screen.getAllByRole("button", {
      name: /^(Workspace|Members|Agent|Account|Usage)$/,
    });
    expect(items.map((b) => b.textContent)).toEqual([
      "Workspace",
      "Members",
      "Agent",
      "Account",
      "Usage",
    ]);

    // Not rendered until selected.
    expect(screen.queryByText("Usage for ws_1")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Usage" }));
    expect(screen.getByText("Usage for ws_1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Usage" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // The built-in panels are gone while an extra section is active.
    expect(
      screen.queryByRole("heading", { name: "Workspace" }),
    ).not.toBeInTheDocument();
  });

  it("ignores an extra section whose id shadows a built-in", async () => {
    renderPanel(ADMIN_WS, {
      extraSections: [
        {
          id: "members",
          label: "Shadow",
          render: () => <p>shadowed</p>,
        },
      ],
    });

    // The colliding entry never reaches the nav.
    expect(
      screen.queryByRole("button", { name: "Shadow" }),
    ).not.toBeInTheDocument();

    // The built-in Members section still renders its own panel.
    await userEvent.click(screen.getByRole("button", { name: "Members" }));
    expect(
      screen.getByRole("heading", { name: "Members" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("shadowed")).not.toBeInTheDocument();
  });

  it("keeps the first injected section when ids collide", async () => {
    renderPanel(ADMIN_WS, {
      extraSections: [
        {
          id: "host-tools",
          label: "First tools",
          render: () => <p>first content</p>,
        },
        {
          id: "host-tools",
          label: "Second tools",
          render: () => <p>second content</p>,
        },
      ],
    });

    expect(screen.getAllByRole("button", { name: /tools/i })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "First tools" }));
    expect(screen.getByText("first content")).toBeInTheDocument();
    expect(screen.queryByText("second content")).not.toBeInTheDocument();
  });

  it("opens a requested injected section and handles a repeated request", async () => {
    const extraSections = [
      {
        id: "host-tools",
        label: "Host tools",
        render: ({ workspaceId }: { workspaceId: string }) => (
          <p>Host tools for {workspaceId}</p>
        ),
      },
    ];
    const view = renderPanel(ADMIN_WS, {
      extraSections,
      sectionRequest: { id: "host-tools", nonce: 1 },
    });

    expect(await screen.findByText("Host tools for ws_1")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Workspace" }));
    expect(screen.queryByText("Host tools for ws_1")).not.toBeInTheDocument();

    view.rerender(
      <ShepherdClientProvider client={client}>
        <ConfigPanel
          workspace={ADMIN_WS}
          extraSections={extraSections}
          sectionRequest={{ id: "host-tools", nonce: 2 }}
        />
      </ShepherdClientProvider>,
    );
    expect(await screen.findByText("Host tools for ws_1")).toBeInTheDocument();
  });

  it("ignores an unknown requested section", async () => {
    renderPanel(ADMIN_WS, {
      sectionRequest: { id: "missing", nonce: 1 },
    });

    expect(
      await screen.findByRole("heading", { name: "Workspace" }),
    ).toBeInTheDocument();
  });

  it("marks the active nav item with aria-current", async () => {
    renderPanel();
    const workspace = screen.getByRole("button", { name: "Workspace" });
    expect(workspace).toHaveAttribute("aria-current", "page");

    await userEvent.click(screen.getByRole("button", { name: "Agent" }));
    expect(screen.getByRole("button", { name: "Agent" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(workspace).not.toHaveAttribute("aria-current");
  });
});
