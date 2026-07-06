import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ShepherdClientProvider } from "../context.js";
import { GeneralSettings } from "./GeneralSettings.js";
import { makeMockClient } from "../test/mockClient.js";
import { ShepherdClientError } from "../client.js";
import type { WorkspaceSummaryT } from "@shepherd/shared";

// ---------------------------------------------------------------------------
// GeneralSettings — the Config → General tab. Shows the active workspace's name
// and the caller's role, and owns the self-service "Leave workspace" action
// (moved here from the roster). The hub enforces the last-admin guard; a
// rejected leave surfaces as a visible alert.
// ---------------------------------------------------------------------------

const WS: WorkspaceSummaryT = { id: "ws_1", slug: "acme", name: "Acme Engineering", role: "admin" };

describe("GeneralSettings", () => {
  let client: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    client = makeMockClient();
  });

  function renderGeneral(
    props?: Partial<{
      workspace: WorkspaceSummaryT;
      onLeft: () => void;
      onDeleted: () => void;
    }>,
  ) {
    return render(
      <ShepherdClientProvider client={client}>
        <GeneralSettings
          workspace={props?.workspace ?? WS}
          onLeft={props?.onLeft}
          onDeleted={props?.onDeleted}
        />
      </ShepherdClientProvider>,
    );
  }

  it("shows the workspace name and the caller's role", () => {
    renderGeneral();
    expect(screen.getByText("Acme Engineering")).toBeInTheDocument();
    expect(screen.getByText("admin")).toBeInTheDocument();
  });

  it("leaves the workspace through the client and calls onLeft", async () => {
    client.leave = vi.fn().mockResolvedValue(undefined);
    const onLeft = vi.fn();
    renderGeneral({ onLeft });

    await userEvent.click(screen.getByRole("button", { name: /leave workspace/i }));

    await waitFor(() => expect(client.leave).toHaveBeenCalledWith("ws_1"));
    await waitFor(() => expect(onLeft).toHaveBeenCalledTimes(1));
  });

  it("surfaces an error and does NOT call onLeft when leave is rejected", async () => {
    client.leave = vi.fn().mockRejectedValue(new Error("cannot leave as the last admin"));
    const onLeft = vi.fn();
    renderGeneral({ onLeft });

    await userEvent.click(screen.getByRole("button", { name: /leave workspace/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/last admin/i);
    expect(onLeft).not.toHaveBeenCalled();
  });

  it("disables the leave button while a leave is in flight", async () => {
    let resolve!: () => void;
    client.leave = vi.fn().mockReturnValue(
      new Promise<void>((r) => {
        resolve = r;
      }),
    );
    renderGeneral();

    const btn = screen.getByRole("button", { name: /leave workspace/i });
    await userEvent.click(btn);

    await waitFor(() => expect(btn).toBeDisabled());
    expect(client.leave).toHaveBeenCalledTimes(1);

    resolve();
    await waitFor(() => expect(btn).not.toBeDisabled());
  });

  // --- Delete workspace ----------------------------------------------------

  it("does NOT show the Delete section for a non-admin member", () => {
    renderGeneral({ workspace: { ...WS, role: "member" } });
    // The leave button is present; the delete trigger is not.
    expect(screen.getByRole("button", { name: /leave workspace/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete workspace/i })).toBeNull();
  });

  it("requires typing the exact workspace name before Delete is enabled, then deletes and calls onDeleted", async () => {
    client.deleteWorkspace = vi.fn().mockResolvedValue({ deleted: true });
    const onDeleted = vi.fn();
    renderGeneral({ onDeleted });

    // Open the confirm modal from the Delete section trigger.
    await userEvent.click(screen.getByRole("button", { name: /delete workspace/i }));
    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: /delete workspace/i });

    // Disabled until the exact name is typed.
    expect(confirm).toBeDisabled();
    const input = within(dialog).getByRole("textbox");
    await userEvent.type(input, "Wrong Name");
    expect(confirm).toBeDisabled();

    await userEvent.clear(input);
    await userEvent.type(input, "Acme Engineering");
    expect(confirm).toBeEnabled();

    await userEvent.click(confirm);
    await waitFor(() => expect(client.deleteWorkspace).toHaveBeenCalledWith("ws_1"));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
  });

  it("points the last admin at Delete when a leave is rejected with 409", async () => {
    client.leave = vi
      .fn()
      .mockRejectedValue(new ShepherdClientError("HTTP 409: You are the last admin", 409));
    renderGeneral(); // WS.role === "admin"

    await userEvent.click(screen.getByRole("button", { name: /leave workspace/i }));

    // The hint steers them to the Delete action below.
    expect(await screen.findByText(/delete it below/i)).toBeInTheDocument();
  });
});
