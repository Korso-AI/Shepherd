import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ShepherdClientProvider } from "../context.js";
import { AccountActions } from "./AccountActions.js";
import { makeMockClient } from "../test/mockClient.js";

// ---------------------------------------------------------------------------
// AccountActions — the Sign out / Delete account rows of Config → General
// (also reused by the no-workspace Config screen). Delete is guarded by the
// type-to-confirm modal; a confirmed delete calls client.deleteAccount() and
// then the host's onLogout (the session's account no longer exists).
// ---------------------------------------------------------------------------

describe("AccountActions", () => {
  let client: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    client = makeMockClient();
  });

  function renderActions(onLogout?: () => void) {
    return render(
      <ShepherdClientProvider client={client}>
        <AccountActions onLogout={onLogout} />
      </ShepherdClientProvider>,
    );
  }

  it("invokes onLogout when Sign out is clicked", async () => {
    const onLogout = vi.fn();
    renderActions(onLogout);

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("hides the Sign out row without an onLogout, but keeps Delete account", () => {
    renderActions();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete account" })).toBeInTheDocument();
  });

  it("opens the confirm modal and keeps Delete disabled until the phrase matches", async () => {
    renderActions(vi.fn());

    await userEvent.click(screen.getByRole("button", { name: "Delete account" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();

    // Two "Delete account" buttons exist now (field + modal); scope to the dialog.
    const modalConfirm = Array.from(
      dialog.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent === "Delete account");
    if (!modalConfirm) throw new Error("Expected the modal's Delete button");
    expect(modalConfirm).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/type/i), "delete my account");
    expect(modalConfirm).not.toBeDisabled();
  });

  it("deletes the account on confirm, then signs the session out", async () => {
    const onLogout = vi.fn();
    renderActions(onLogout);

    await userEvent.click(screen.getByRole("button", { name: "Delete account" }));
    await userEvent.type(screen.getByLabelText(/type/i), "delete my account");

    const dialog = screen.getByRole("dialog");
    const modalConfirm = Array.from(
      dialog.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent === "Delete account");
    if (!modalConfirm) throw new Error("Expected the modal's Delete button");
    await userEvent.click(modalConfirm);

    await waitFor(() => expect(client.deleteAccount).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1));
  });

  it("surfaces a failed delete in the modal and does NOT sign out", async () => {
    const onLogout = vi.fn();
    client.deleteAccount = vi
      .fn()
      .mockRejectedValue(
        new Error('HTTP 409: You\'re the last admin of "Acme", which still has other members.'),
      );
    renderActions(onLogout);

    await userEvent.click(screen.getByRole("button", { name: "Delete account" }));
    await userEvent.type(screen.getByLabelText(/type/i), "delete my account");
    const dialog = screen.getByRole("dialog");
    const modalConfirm = Array.from(
      dialog.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent === "Delete account");
    if (!modalConfirm) throw new Error("Expected the modal's Delete button");
    await userEvent.click(modalConfirm);

    expect(await screen.findByRole("alert")).toHaveTextContent(/last admin/i);
    expect(onLogout).not.toHaveBeenCalled();
    // The modal stays open so the operator can read the reason.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("cancel closes the modal without deleting", async () => {
    renderActions(vi.fn());

    await userEvent.click(screen.getByRole("button", { name: "Delete account" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(client.deleteAccount).not.toHaveBeenCalled();
  });
});
