import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ShepherdClientProvider } from "./context.js";
import { ShepherdRoot } from "./ShepherdRoot.js";
import { makeMockClient } from "./test/mockClient.js";

// Proves the hosted shell mounts inside the provider and renders ONE flat tab
// strip [Tasks, Chat, Settings] — Settings is a third peer tab beside the
// original Tasks/Chat board views, not a nested second tab layer. The shell
// lands after listWorkspaces() resolves, so we inject a workspace and wait
// for the load.
describe("ShepherdRoot", () => {
  const WS = {
    id: "ws_1",
    slug: "acme",
    name: "Acme",
    role: "admin" as const,
    isOwner: true,
  };

  beforeEach(() => {
    // Dashboard persists the active tab to localStorage; clear it so each test
    // starts from the default landing tab rather than a prior test's pick.
    localStorage.clear();
  });

  function renderRoot(rootProps: { onLogout?: () => void } = {}) {
    const client = makeMockClient({
      listWorkspaces: vi.fn().mockResolvedValue({ workspaces: [WS] }),
    });
    return render(
      <ShepherdClientProvider client={client}>
        <ShepherdRoot {...rootProps} />
      </ShepherdClientProvider>,
    );
  }

  it("mounts and shows the flat Tasks | Chat | Settings tab strip", async () => {
    renderRoot();
    expect(
      await screen.findByRole("tab", { name: "Tasks" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Chat" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Settings" })).toBeInTheDocument();
  });

  it("defaults to the Tasks view when a workspace exists", async () => {
    renderRoot();
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Tasks" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
  });

  it("switches to the Settings view when its tab is clicked", async () => {
    renderRoot();
    await userEvent.click(await screen.findByRole("tab", { name: "Settings" }));
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // The Settings panel is the sidebar layout, defaulting to the Workspace section.
    expect(
      screen.getByRole("heading", { name: "Workspace" }),
    ).toBeInTheDocument();
  });

  it("renders the hosted sign out action on the Settings → Account section", async () => {
    const onLogout = vi.fn();
    renderRoot({ onLogout });

    await userEvent.click(await screen.findByRole("tab", { name: "Settings" }));
    // Sign out moved out of the Workspace tab into its own Account section.
    await userEvent.click(screen.getByRole("button", { name: "Account" }));
    await userEvent.click(screen.getByRole("button", { name: /sign out/i }));

    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("does not render the sign out action when no hosted logout hook is supplied", async () => {
    renderRoot();

    await userEvent.click(await screen.findByRole("tab", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Account" }));

    expect(
      screen.queryByRole("button", { name: /sign out/i }),
    ).not.toBeInTheDocument();
  });

  it("applies a roving tabindex (selected tab = 0, others = -1)", async () => {
    renderRoot();
    const tasks = await screen.findByRole("tab", { name: "Tasks" });
    const chat = screen.getByRole("tab", { name: "Chat" });
    const settings = screen.getByRole("tab", { name: "Settings" });
    // Lands on Tasks, so Tasks is the single tab stop.
    expect(tasks).toHaveAttribute("tabindex", "0");
    expect(chat).toHaveAttribute("tabindex", "-1");
    expect(settings).toHaveAttribute("tabindex", "-1");
  });

  it("navigates tabs with the arrow keys, moving selection and focus", async () => {
    renderRoot();
    const tasks = await screen.findByRole("tab", { name: "Tasks" });
    const chat = screen.getByRole("tab", { name: "Chat" });
    const settings = screen.getByRole("tab", { name: "Settings" });

    tasks.focus();
    expect(tasks).toHaveFocus();

    // ArrowRight → Chat (selected + focused).
    await userEvent.keyboard("{ArrowRight}");
    expect(chat).toHaveAttribute("aria-selected", "true");
    expect(chat).toHaveFocus();
    expect(chat).toHaveAttribute("tabindex", "0");
    expect(tasks).toHaveAttribute("tabindex", "-1");

    // ArrowRight → Settings.
    await userEvent.keyboard("{ArrowRight}");
    expect(settings).toHaveAttribute("aria-selected", "true");
    expect(settings).toHaveFocus();

    // ArrowRight again wraps around to Tasks.
    await userEvent.keyboard("{ArrowRight}");
    expect(tasks).toHaveAttribute("aria-selected", "true");
    expect(tasks).toHaveFocus();

    // ArrowLeft wraps back to Settings.
    await userEvent.keyboard("{ArrowLeft}");
    expect(settings).toHaveAttribute("aria-selected", "true");
    expect(settings).toHaveFocus();
  });

  it("supports Home/End to jump to the first/last tab", async () => {
    renderRoot();
    const tasks = await screen.findByRole("tab", { name: "Tasks" });
    const settings = screen.getByRole("tab", { name: "Settings" });

    tasks.focus();
    await userEvent.keyboard("{End}");
    expect(settings).toHaveAttribute("aria-selected", "true");
    expect(settings).toHaveFocus();

    await userEvent.keyboard("{Home}");
    expect(tasks).toHaveAttribute("aria-selected", "true");
    expect(tasks).toHaveFocus();
  });
});
