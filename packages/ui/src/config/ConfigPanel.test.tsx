import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { ShepherdClientProvider } from "../context.js";
import { ConfigPanel } from "./ConfigPanel.js";
import { makeMockClient } from "../test/mockClient.js";
import type { WorkspaceSummaryT } from "@shepherd/shared";

// ---------------------------------------------------------------------------
// ConfigPanel — the Config tab body: a left nav (General · Members · Agent)
// beside the active section's panel. General is the default; Members shows the
// roster plus (admin-only) Invites; Agent shows the connect flow.
// ---------------------------------------------------------------------------

const ADMIN_WS: WorkspaceSummaryT = { id: "ws_1", slug: "acme", name: "Acme", role: "admin" };
const MEMBER_WS: WorkspaceSummaryT = { id: "ws_2", slug: "beta", name: "Beta", role: "member" };

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

  it("defaults to the General section", () => {
    renderPanel();
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
    // General shows the workspace name.
    expect(screen.getByText("Acme")).toBeInTheDocument();
  });

  it("renders a session sign out action below the Config content when logout is supplied", async () => {
    const onLogout = vi.fn();
    const { container } = renderPanel(ADMIN_WS, { onLogout });

    expect(screen.getByRole("heading", { name: "Session" })).toBeInTheDocument();
    expect(screen.getByText("Sign out of this Shepherd dashboard session.")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Sign out" });

    const configLayout = container.querySelector(".config-layout");
    const signOut = container.querySelector(".config-signout");
    if (!configLayout || !signOut) throw new Error("Expected Config layout and sign out action");
    expect(configLayout.compareDocumentPosition(signOut)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    await userEvent.click(button);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("does not render the session sign out action without a logout callback", () => {
    renderPanel();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
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
    const general = screen.getByRole("button", { name: "General" });
    expect(general).toHaveAttribute("aria-current", "page");

    await userEvent.click(screen.getByRole("button", { name: "Agent" }));
    expect(screen.getByRole("button", { name: "Agent" })).toHaveAttribute("aria-current", "page");
    expect(general).not.toHaveAttribute("aria-current");
  });
});
