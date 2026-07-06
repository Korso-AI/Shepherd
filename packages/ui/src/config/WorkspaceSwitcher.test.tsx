import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ShepherdClientProvider } from "../context.js";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.js";
import { makeMockClient } from "../test/mockClient.js";
import type { WorkspaceSummaryT } from "@shepherd/shared";

// ---------------------------------------------------------------------------
// WorkspaceSwitcher — the app-bar control. Shows the ACTIVE workspace name and
// owns switch / create / join. With no workspace it degrades to a "Get started"
// menu. create/join were moved here from the old <Workspaces> Config section.
// ---------------------------------------------------------------------------

const WS_A: WorkspaceSummaryT = { id: "ws_a", slug: "acme", name: "Acme", role: "admin" };
const WS_B: WorkspaceSummaryT = { id: "ws_b", slug: "beta", name: "Beta", role: "member" };

describe("WorkspaceSwitcher", () => {
  let client: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    client = makeMockClient();
  });

  function renderSwitcher(
    props: Partial<{
      workspaces: WorkspaceSummaryT[];
      selected: WorkspaceSummaryT | null;
      onSelect: (id: string) => void;
      onChanged: () => void;
      onMembersChanged: () => void;
    }> = {},
  ) {
    const selected = props.selected === undefined ? WS_A : props.selected;
    const workspaces = props.workspaces ?? (selected ? [selected] : []);
    return render(
      <ShepherdClientProvider client={client}>
        <WorkspaceSwitcher
          workspaces={workspaces}
          selected={selected}
          onSelect={props.onSelect ?? (() => {})}
          onChanged={props.onChanged ?? (() => {})}
          onMembersChanged={props.onMembersChanged}
        />
      </ShepherdClientProvider>,
    );
  }

  it("shows the active workspace name on the trigger", () => {
    renderSwitcher({ selected: WS_A });
    expect(screen.getByRole("button", { name: /acme/i })).toBeInTheDocument();
  });

  it("shows a 'Get started' trigger when there is no workspace", () => {
    renderSwitcher({ selected: null });
    expect(screen.getByRole("button", { name: /get started/i })).toBeInTheDocument();
  });

  it("lists all workspaces and switches when one is picked", async () => {
    const onSelect = vi.fn();
    renderSwitcher({ workspaces: [WS_A, WS_B], selected: WS_A, onSelect });

    await userEvent.click(screen.getByRole("button", { name: /acme/i }));
    // Both workspaces appear in the open menu; picking Beta calls onSelect.
    await userEvent.click(screen.getByRole("menuitemradio", { name: /beta/i }));

    expect(onSelect).toHaveBeenCalledWith("ws_b");
  });

  it("marks the active workspace as checked in the menu", async () => {
    renderSwitcher({ workspaces: [WS_A, WS_B], selected: WS_A });
    await userEvent.click(screen.getByRole("button", { name: /acme/i }));

    expect(screen.getByRole("menuitemradio", { name: /acme/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("menuitemradio", { name: /beta/i })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("creates a workspace, selects it, then re-lists", async () => {
    client.createWorkspace = vi
      .fn()
      .mockResolvedValue({ id: "ws_new", slug: "new", name: "My Team", role: "admin" });
    const onSelect = vi.fn();
    const onChanged = vi.fn();
    renderSwitcher({ selected: WS_A, onSelect, onChanged });

    await userEvent.click(screen.getByRole("button", { name: /acme/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /create workspace/i }));
    await userEvent.type(screen.getByLabelText(/new workspace name/i), "My Team");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => expect(client.createWorkspace).toHaveBeenCalledWith({ name: "My Team" }));
    expect(onSelect).toHaveBeenCalledWith("ws_new");
    expect(onChanged).toHaveBeenCalled();
  });

  it("joins by redeeming an invite code, selects the joined workspace, and refreshes members", async () => {
    client.redeemInvite = vi
      .fn()
      .mockResolvedValue({ workspace: { id: "ws_join", slug: "j", name: "Joined", role: "member" } });
    const onSelect = vi.fn();
    const onChanged = vi.fn();
    const onMembersChanged = vi.fn();
    renderSwitcher({ selected: WS_A, onSelect, onChanged, onMembersChanged });

    await userEvent.click(screen.getByRole("button", { name: /acme/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /join with a code/i }));
    await userEvent.type(screen.getByLabelText(/invite code/i), "INV-123");
    await userEvent.click(screen.getByRole("button", { name: /^join$/i }));

    await waitFor(() => expect(client.redeemInvite).toHaveBeenCalledWith("INV-123"));
    expect(onSelect).toHaveBeenCalledWith("ws_join");
    expect(onChanged).toHaveBeenCalled();
    expect(onMembersChanged).toHaveBeenCalledTimes(1);
  });

  it("surfaces a create error inside the menu without closing it", async () => {
    client.createWorkspace = vi.fn().mockRejectedValue(new Error("name already taken"));
    renderSwitcher({ selected: WS_A });

    await userEvent.click(screen.getByRole("button", { name: /acme/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /create workspace/i }));
    await userEvent.type(screen.getByLabelText(/new workspace name/i), "Dup");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/already taken/i);
  });

  it("closes the menu on Escape", async () => {
    renderSwitcher({ workspaces: [WS_A, WS_B], selected: WS_A });
    await userEvent.click(screen.getByRole("button", { name: /acme/i }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
