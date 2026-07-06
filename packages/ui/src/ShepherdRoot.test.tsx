import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ShepherdClientProvider } from "./context.js";
import { ShepherdRoot } from "./ShepherdRoot.js";
import { makeMockClient } from "./test/mockClient.js";

// Proves the hosted shell mounts inside the provider and renders ONE flat tab
// strip [Tasks, Chat, Config] — Config is a third peer tab beside the original
// Tasks/Chat board views, not a nested second tab layer. The shell lands after
// listWorkspaces() resolves, so we inject a workspace and wait for the load.
describe("ShepherdRoot", () => {
  const WS = { id: "ws_1", slug: "acme", name: "Acme", role: "admin" as const };

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

  it("mounts and shows the flat Tasks | Chat | Config tab strip", async () => {
    renderRoot();
    expect(await screen.findByRole("tab", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Chat" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Config" })).toBeInTheDocument();
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

  it("switches to the Config view when its tab is clicked", async () => {
    renderRoot();
    await userEvent.click(await screen.findByRole("tab", { name: "Config" }));
    expect(screen.getByRole("tab", { name: "Config" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // The Config panel is the sidebar layout, defaulting to the General section.
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
  });

  it("renders the hosted sign out action at the bottom of Config", async () => {
    const onLogout = vi.fn();
    renderRoot({ onLogout });

    await userEvent.click(await screen.findByRole("tab", { name: "Config" }));
    await userEvent.click(screen.getByRole("button", { name: /sign out/i }));

    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("does not render the sign out action when no hosted logout hook is supplied", async () => {
    renderRoot();

    await userEvent.click(await screen.findByRole("tab", { name: "Config" }));

    expect(screen.queryByRole("button", { name: /sign out/i })).not.toBeInTheDocument();
  });

  it("applies a roving tabindex (selected tab = 0, others = -1)", async () => {
    renderRoot();
    const tasks = await screen.findByRole("tab", { name: "Tasks" });
    const chat = screen.getByRole("tab", { name: "Chat" });
    const config = screen.getByRole("tab", { name: "Config" });
    // Lands on Tasks, so Tasks is the single tab stop.
    expect(tasks).toHaveAttribute("tabindex", "0");
    expect(chat).toHaveAttribute("tabindex", "-1");
    expect(config).toHaveAttribute("tabindex", "-1");
  });

  it("navigates tabs with the arrow keys, moving selection and focus", async () => {
    renderRoot();
    const tasks = await screen.findByRole("tab", { name: "Tasks" });
    const chat = screen.getByRole("tab", { name: "Chat" });
    const config = screen.getByRole("tab", { name: "Config" });

    tasks.focus();
    expect(tasks).toHaveFocus();

    // ArrowRight → Chat (selected + focused).
    await userEvent.keyboard("{ArrowRight}");
    expect(chat).toHaveAttribute("aria-selected", "true");
    expect(chat).toHaveFocus();
    expect(chat).toHaveAttribute("tabindex", "0");
    expect(tasks).toHaveAttribute("tabindex", "-1");

    // ArrowRight → Config.
    await userEvent.keyboard("{ArrowRight}");
    expect(config).toHaveAttribute("aria-selected", "true");
    expect(config).toHaveFocus();

    // ArrowRight again wraps around to Tasks.
    await userEvent.keyboard("{ArrowRight}");
    expect(tasks).toHaveAttribute("aria-selected", "true");
    expect(tasks).toHaveFocus();

    // ArrowLeft wraps back to Config.
    await userEvent.keyboard("{ArrowLeft}");
    expect(config).toHaveAttribute("aria-selected", "true");
    expect(config).toHaveFocus();
  });

  it("supports Home/End to jump to the first/last tab", async () => {
    renderRoot();
    const tasks = await screen.findByRole("tab", { name: "Tasks" });
    const config = screen.getByRole("tab", { name: "Config" });

    tasks.focus();
    await userEvent.keyboard("{End}");
    expect(config).toHaveAttribute("aria-selected", "true");
    expect(config).toHaveFocus();

    await userEvent.keyboard("{Home}");
    expect(tasks).toHaveAttribute("aria-selected", "true");
    expect(tasks).toHaveFocus();
  });
});
