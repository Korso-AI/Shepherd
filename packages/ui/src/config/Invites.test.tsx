import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ShepherdClientProvider } from "../context.js";
import { Invites } from "./Invites.js";
import { makeMockClient } from "../test/mockClient.js";

// ---------------------------------------------------------------------------
// Invites — admin-only "add people" controls in the Config → Members tab.
// Code invites (create / revoke / use count / join link) and one-time email
// invites. The caller admin-gates this component; it only owns the client calls.
// ---------------------------------------------------------------------------

const WS_ID = "ws_1";

describe("Invites", () => {
  let client: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    client = makeMockClient();
  });

  function renderInvites(props?: Partial<{ onMembersChanged: () => void }>) {
    return render(
      <ShepherdClientProvider client={client}>
        <Invites workspaceId={WS_ID} onMembersChanged={props?.onMembersChanged} />
      </ShepherdClientProvider>,
    );
  }

  it("creates an invite and shows the code + join link", async () => {
    client.createInvite = vi.fn().mockResolvedValue({
      code: "INV-NEW",
      expiresAt: null,
      maxUses: 5,
      useCount: 0,
    });
    renderInvites();

    await userEvent.click(screen.getByRole("button", { name: /create invite/i }));

    await waitFor(() =>
      expect(client.createInvite).toHaveBeenCalledWith(WS_ID, expect.any(Object)),
    );
    await waitFor(() => expect(screen.getByText("INV-NEW")).toBeInTheDocument());
    expect(screen.getByText(/\/join\/INV-NEW/)).toBeInTheDocument();
  });

  it("revokes a displayed invite", async () => {
    client.createInvite = vi.fn().mockResolvedValue({
      code: "INV-NEW",
      expiresAt: null,
      maxUses: 5,
      useCount: 0,
    });
    renderInvites();

    await userEvent.click(screen.getByRole("button", { name: /create invite/i }));
    await waitFor(() => expect(screen.getByText("INV-NEW")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /revoke invite/i }));

    await waitFor(() => expect(client.revokeInvite).toHaveBeenCalledWith(WS_ID, "INV-NEW"));
  });

  it("shows the invite's use count alongside the code", async () => {
    client.createInvite = vi.fn().mockResolvedValue({
      code: "INV-USES",
      expiresAt: null,
      maxUses: 5,
      useCount: 2,
    });
    renderInvites();

    await userEvent.click(screen.getByRole("button", { name: /create invite/i }));

    expect(await screen.findByText(/2 \/ 5 uses/)).toBeInTheDocument();
  });

  it("shows 'unlimited' phrasing (no cap) when maxUses is null", async () => {
    client.createInvite = vi.fn().mockResolvedValue({
      code: "INV-UNLIMITED",
      expiresAt: null,
      maxUses: null,
      useCount: 3,
    });
    renderInvites();

    await userEvent.click(screen.getByRole("button", { name: /create invite/i }));

    expect(await screen.findByText(/^3 uses$/)).toBeInTheDocument();
    expect(screen.queryByText(/\/ null uses/)).not.toBeInTheDocument();
  });

  it("encodes the invite code in the join link", async () => {
    client.createInvite = vi.fn().mockResolvedValue({
      code: "INV NEW/42",
      expiresAt: null,
      maxUses: 5,
      useCount: 0,
    });
    renderInvites();

    await userEvent.click(screen.getByRole("button", { name: /create invite/i }));

    const link = await screen.findByRole("link");
    expect(link).toHaveAttribute("href", expect.stringContaining("/shepherd/join/INV%20NEW%2F42"));
  });

  it("notifies the parent via onMembersChanged after creating an invite", async () => {
    client.createInvite = vi.fn().mockResolvedValue({
      code: "INV-NEW",
      expiresAt: null,
      maxUses: 5,
      useCount: 0,
    });
    const onMembersChanged = vi.fn();
    renderInvites({ onMembersChanged });

    await userEvent.click(screen.getByRole("button", { name: /create invite/i }));

    await waitFor(() => expect(client.createInvite).toHaveBeenCalled());
    expect(onMembersChanged).toHaveBeenCalledTimes(1);
  });

  it("gates createInvite against double-submit", async () => {
    let resolve!: (v: unknown) => void;
    client.createInvite = vi.fn().mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    renderInvites();

    const btn = screen.getByRole("button", { name: /create invite/i });
    await userEvent.click(btn);

    await waitFor(() => expect(btn).toBeDisabled());
    await userEvent.click(btn);
    expect(client.createInvite).toHaveBeenCalledTimes(1);

    resolve({ code: "INV-NEW", expiresAt: null, maxUses: 5, useCount: 0 });
    await waitFor(() => expect(btn).not.toBeDisabled());
  });

  it("sends an email invite and shows a success status, clearing the field", async () => {
    client.inviteByEmail = vi.fn().mockResolvedValue({
      email: "newcomer@example.com",
      sentAt: "2026-06-30T00:00:00.000Z",
    });
    const onMembersChanged = vi.fn();
    renderInvites({ onMembersChanged });

    await userEvent.type(screen.getByLabelText(/invite by email/i), "newcomer@example.com");
    await userEvent.click(screen.getByRole("button", { name: /send invite/i }));

    await waitFor(() =>
      expect(client.inviteByEmail).toHaveBeenCalledWith(WS_ID, "newcomer@example.com"),
    );
    expect(await screen.findByText(/invite sent to newcomer@example\.com/i)).toBeInTheDocument();
    expect(onMembersChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText(/invite by email/i)).toHaveValue("");
  });

  it("shows an error status when the email invite fails, without clearing the field", async () => {
    client.inviteByEmail = vi
      .fn()
      .mockRejectedValue(new Error("HTTP 501: email invites are not configured on this server"));
    renderInvites();

    await userEvent.type(screen.getByLabelText(/invite by email/i), "newcomer@example.com");
    await userEvent.click(screen.getByRole("button", { name: /send invite/i }));

    expect(await screen.findByText(/not configured on this server/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/invite by email/i)).toHaveValue("newcomer@example.com");
  });

  it("gates sendEmailInvite against double-submit", async () => {
    let resolve!: (v: unknown) => void;
    client.inviteByEmail = vi.fn().mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    renderInvites();

    await userEvent.type(screen.getByLabelText(/invite by email/i), "newcomer@example.com");
    const btn = screen.getByRole("button", { name: /send invite/i });
    await userEvent.click(btn);

    await waitFor(() => expect(btn).toBeDisabled());
    await userEvent.click(btn);
    expect(client.inviteByEmail).toHaveBeenCalledTimes(1);

    resolve({ email: "newcomer@example.com", sentAt: "2026-06-30T00:00:00.000Z" });
    await waitFor(() => expect(btn).not.toBeDisabled());
  });
});
