import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { MemberSummaryT } from "@shepherd/shared";
import { ShepherdClientProvider } from "../context.js";
import { Members } from "./Members.js";
import { makeMockClient } from "../test/mockClient.js";

// ---------------------------------------------------------------------------
// Members — the workspace roster. Fetches the list on mount (and whenever
// refreshKey changes), removes members through the client, and (owner-only)
// promotes/demotes members and transfers ownership. Rejections surface as a
// visible alert. Self-service "leave" lives in <WorkspaceSettings>.
//
// Row controls live behind a per-row "⋯" actions menu (trigger labelled
// `Actions for <name>`), so action tests open the menu first and click
// menuitems; a row the caller cannot act on renders no trigger at all.
// ---------------------------------------------------------------------------

const WORKSPACE_ID = "ws_1";

/** A member fixture with sane isOwner default (false unless overridden). */
function member(
  m: Partial<MemberSummaryT> & { accountId: string },
): MemberSummaryT {
  return {
    displayName: null,
    githubLogin: null,
    email: null,
    avatarUrl: null,
    role: "member",
    isOwner: false,
    ...m,
  };
}

describe("Members", () => {
  let client: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    client = makeMockClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderMembers(
    props?: Partial<{
      refreshKey: number;
      canRemove: boolean;
      isOwner: boolean;
      onMembersChanged: () => void;
      onWorkspaceChanged: () => void;
    }>,
  ) {
    return render(
      <ShepherdClientProvider client={client}>
        <Members workspaceId={WORKSPACE_ID} {...props} />
      </ShepherdClientProvider>,
    );
  }

  it("lists members fetched from the client", async () => {
    client.listMembers = vi.fn().mockResolvedValue({
      members: [
        member({
          accountId: "acc_1",
          displayName: "Alice",
          githubLogin: "alice",
          role: "admin",
        }),
      ],
    });

    renderMembers();

    await waitFor(() =>
      expect(client.listMembers).toHaveBeenCalledWith(WORKSPACE_ID),
    );
    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("admin")).toBeInTheDocument();
  });

  it("badges the owner as 'owner' rather than 'admin'", async () => {
    client.listMembers = vi.fn().mockResolvedValue({
      members: [
        member({
          accountId: "acc_owner",
          displayName: "Olive",
          role: "admin",
          isOwner: true,
        }),
      ],
    });

    renderMembers();

    expect(await screen.findByText("Olive")).toBeInTheDocument();
    expect(screen.getByText("owner")).toBeInTheDocument();
    expect(screen.queryByText("admin")).toBeNull();
  });

  it("falls back to email, then the account id, when name/login are absent", async () => {
    client.listMembers = vi.fn().mockResolvedValue({
      members: [
        member({
          accountId: "acc_email",
          email: "dana@example.com",
          role: "admin",
        }),
        member({ accountId: "acc_bare" }),
      ],
    });

    renderMembers();

    // Prefer the email over the raw account id when no name/login exists…
    expect(await screen.findByText("dana@example.com")).toBeInTheDocument();
    expect(screen.queryByText("acc_email")).not.toBeInTheDocument();
    // …but the account id is still the last-resort label.
    expect(screen.getByText("acc_bare")).toBeInTheDocument();
  });

  it("shows an empty state when there are no members", async () => {
    client.listMembers = vi.fn().mockResolvedValue({ members: [] });

    renderMembers();

    expect(await screen.findByText(/no members/i)).toBeInTheDocument();
  });

  it("refetches when refreshKey changes", async () => {
    client.listMembers = vi.fn().mockResolvedValue({ members: [] });

    const { rerender } = renderMembers({ refreshKey: 0 });
    await waitFor(() => expect(client.listMembers).toHaveBeenCalledTimes(1));

    rerender(
      <ShepherdClientProvider client={client}>
        <Members workspaceId={WORKSPACE_ID} refreshKey={1} />
      </ShepherdClientProvider>,
    );
    await waitFor(() => expect(client.listMembers).toHaveBeenCalledTimes(2));
  });

  it("removes a member through the client when canRemove", async () => {
    client.listMembers = vi.fn().mockResolvedValue({
      members: [
        member({ accountId: "acc_2", displayName: "Bob", role: "member" }),
      ],
    });
    client.removeMember = vi.fn().mockResolvedValue(undefined);

    renderMembers({ canRemove: true });

    expect(await screen.findByText("Bob")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /actions for bob/i }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: /remove bob/i }),
    );

    await waitFor(() =>
      expect(client.removeMember).toHaveBeenCalledWith(WORKSPACE_ID, "acc_2"),
    );
    // Optimistically dropped from the list.
    await waitFor(() =>
      expect(screen.queryByText("Bob")).not.toBeInTheDocument(),
    );
  });

  it("offers no actions menu on an admin row for a non-owner admin", async () => {
    client.listMembers = vi.fn().mockResolvedValue({
      members: [
        member({ accountId: "acc_a", displayName: "Ada", role: "admin" }),
      ],
    });

    // caller is an admin (canRemove) but NOT the owner: removing an admin is
    // owner-only, and there is nothing else the caller could do — no trigger.
    renderMembers({ canRemove: true, isOwner: false });

    expect(await screen.findByText("Ada")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /actions for ada/i }),
    ).toBeNull();
  });

  it("lets the owner remove another admin", async () => {
    client.listMembers = vi.fn().mockResolvedValue({
      members: [
        member({ accountId: "acc_a", displayName: "Ada", role: "admin" }),
      ],
    });
    client.removeMember = vi.fn().mockResolvedValue(undefined);

    renderMembers({ canRemove: true, isOwner: true });

    expect(await screen.findByText("Ada")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /actions for ada/i }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: /remove ada/i }),
    );
    await waitFor(() =>
      expect(client.removeMember).toHaveBeenCalledWith(WORKSPACE_ID, "acc_a"),
    );
  });

  it("never offers controls on the owner's own row", async () => {
    client.listMembers = vi.fn().mockResolvedValue({
      members: [
        member({
          accountId: "acc_owner",
          displayName: "Olive",
          role: "admin",
          isOwner: true,
        }),
      ],
    });

    renderMembers({ canRemove: true, isOwner: true });

    expect(await screen.findByText("Olive")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /actions for olive/i }),
    ).toBeNull();
  });

  // --- Role controls (owner-only) ------------------------------------------

  it("offers only Remove (no role controls) when the caller is not the owner", async () => {
    client.listMembers = vi.fn().mockResolvedValue({
      members: [
        member({ accountId: "acc_m", displayName: "Mel", role: "member" }),
      ],
    });

    renderMembers({ canRemove: true, isOwner: false });

    expect(await screen.findByText("Mel")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /actions for mel/i }),
    );
    expect(
      screen.getByRole("menuitem", { name: /remove mel/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /make admin/i })).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: /transfer ownership/i }),
    ).toBeNull();
  });

  it("promotes a member to admin through the client (owner)", async () => {
    client.listMembers = vi.fn().mockResolvedValue({
      members: [
        member({ accountId: "acc_m", displayName: "Mel", role: "member" }),
      ],
    });
    client.setMemberRole = vi
      .fn()
      .mockResolvedValue({ ok: true, role: "admin" });
    const onMembersChanged = vi.fn();

    renderMembers({ canRemove: true, isOwner: true, onMembersChanged });

    expect(await screen.findByText("Mel")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /actions for mel/i }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: /make admin/i }),
    );

    await waitFor(() =>
      expect(client.setMemberRole).toHaveBeenCalledWith(
        WORKSPACE_ID,
        "acc_m",
        "admin",
      ),
    );
    await waitFor(() => expect(onMembersChanged).toHaveBeenCalled());
    // Optimistically reflected: reopening the menu now offers demotion.
    await userEvent.click(
      screen.getByRole("button", { name: /actions for mel/i }),
    );
    expect(
      await screen.findByRole("menuitem", { name: /make member/i }),
    ).toBeInTheDocument();
  });

  it("demotes an admin to member through the client (owner)", async () => {
    client.listMembers = vi.fn().mockResolvedValue({
      members: [
        member({ accountId: "acc_a", displayName: "Ada", role: "admin" }),
      ],
    });
    client.setMemberRole = vi
      .fn()
      .mockResolvedValue({ ok: true, role: "member" });

    renderMembers({ canRemove: true, isOwner: true });

    expect(await screen.findByText("Ada")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /actions for ada/i }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: /make member/i }),
    );

    await waitFor(() =>
      expect(client.setMemberRole).toHaveBeenCalledWith(
        WORKSPACE_ID,
        "acc_a",
        "member",
      ),
    );
  });

  // --- Actions menu behavior ------------------------------------------------

  it("closes the actions menu on an outside click", async () => {
    client.listMembers = vi.fn().mockResolvedValue({
      members: [
        member({ accountId: "acc_m", displayName: "Mel", role: "member" }),
      ],
    });

    renderMembers({ canRemove: true, isOwner: true });

    expect(await screen.findByText("Mel")).toBeInTheDocument();
    const trig = screen.getByRole("button", { name: /actions for mel/i });
    await userEvent.click(trig);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    // Click elsewhere in the card (the heading) — the menu dismisses.
    await userEvent.click(screen.getByRole("heading", { name: /members/i }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trig).toHaveAttribute("aria-expanded", "false");
  });

  it("closes the actions menu on Escape", async () => {
    client.listMembers = vi.fn().mockResolvedValue({
      members: [
        member({ accountId: "acc_m", displayName: "Mel", role: "member" }),
      ],
    });

    renderMembers({ canRemove: true, isOwner: true });

    expect(await screen.findByText("Mel")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /actions for mel/i }),
    );
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens at most one row's menu at a time", async () => {
    client.listMembers = vi.fn().mockResolvedValue({
      members: [
        member({ accountId: "acc_m", displayName: "Mel", role: "member" }),
        member({ accountId: "acc_a", displayName: "Ada", role: "admin" }),
      ],
    });

    renderMembers({ canRemove: true, isOwner: true });

    expect(await screen.findByText("Mel")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /actions for mel/i }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /actions for ada/i }),
    );

    // Only Ada's menu remains open.
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(
      screen.getByRole("menuitem", { name: /remove ada/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /remove mel/i })).toBeNull();
  });

  // --- Transfer ownership --------------------------------------------------

  it("transfers ownership through the client after confirmation (owner)", async () => {
    client.listMembers = vi.fn().mockResolvedValue({
      members: [
        member({ accountId: "acc_a", displayName: "Ada", role: "admin" }),
      ],
    });
    client.transferOwnership = vi.fn().mockResolvedValue({ ok: true });
    const onWorkspaceChanged = vi.fn();

    renderMembers({ canRemove: true, isOwner: true, onWorkspaceChanged });

    expect(await screen.findByText("Ada")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /actions for ada/i }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: /transfer ownership/i }),
    );

    // A confirm dialog gates the transfer.
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: /transfer ownership/i }),
    );

    await waitFor(() =>
      expect(client.transferOwnership).toHaveBeenCalledWith(
        WORKSPACE_ID,
        "acc_a",
      ),
    );
    await waitFor(() => expect(onWorkspaceChanged).toHaveBeenCalled());
  });

  it("does not transfer when the confirm dialog is cancelled", async () => {
    client.listMembers = vi.fn().mockResolvedValue({
      members: [
        member({ accountId: "acc_a", displayName: "Ada", role: "admin" }),
      ],
    });
    client.transferOwnership = vi.fn().mockResolvedValue({ ok: true });

    renderMembers({ canRemove: true, isOwner: true });

    expect(await screen.findByText("Ada")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /actions for ada/i }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: /transfer ownership/i }),
    );

    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: /cancel/i }),
    );

    expect(client.transferOwnership).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("surfaces an error when removeMember is rejected (e.g. last-admin guard)", async () => {
    client.listMembers = vi.fn().mockResolvedValue({
      members: [
        member({ accountId: "acc_3", displayName: "Carol", role: "admin" }),
      ],
    });
    client.removeMember = vi
      .fn()
      .mockRejectedValue(new Error("cannot remove the last admin"));

    renderMembers({ canRemove: true, isOwner: true });

    expect(await screen.findByText("Carol")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /actions for carol/i }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: /remove carol/i }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/last admin/i);
    // The optimistic removal is rolled back, so Carol remains on the roster.
    expect(screen.getByText("Carol")).toBeInTheDocument();
  });

  it("shows a loading placeholder until the first fetch resolves", async () => {
    let resolve!: (v: { members: [] }) => void;
    client.listMembers = vi.fn().mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );

    renderMembers();

    // Distinct from the genuine empty state: a status placeholder while fetching.
    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
    expect(screen.queryByText(/no members/i)).not.toBeInTheDocument();

    resolve({ members: [] });
    expect(await screen.findByText(/no members/i)).toBeInTheDocument();
  });

  it("disables the row's remove button while a remove is in flight", async () => {
    client.listMembers = vi.fn().mockResolvedValue({
      members: [
        member({ accountId: "acc_9", displayName: "Dave", role: "member" }),
      ],
    });
    let resolve!: () => void;
    client.removeMember = vi.fn().mockReturnValue(
      new Promise<void>((r) => {
        resolve = r;
      }),
    );

    renderMembers({ canRemove: true });

    await userEvent.click(
      await screen.findByRole("button", { name: /actions for dave/i }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: /remove dave/i }),
    );

    // Optimistically dropped, so the row (and its menu) is gone; resolving
    // completes cleanly.
    await waitFor(() => expect(client.removeMember).toHaveBeenCalledTimes(1));
    resolve();
    expect(await screen.findByRole("status")).toHaveTextContent(
      /removed dave/i,
    );
  });

  it("recovers the roster from the server when a remove is rejected", async () => {
    const members = [
      member({ accountId: "acc_e", displayName: "Erin", role: "admin" }),
    ];
    client.listMembers = vi.fn().mockResolvedValue({ members });
    client.removeMember = vi
      .fn()
      .mockRejectedValue(new Error("cannot remove the last admin"));

    renderMembers({ canRemove: true, isOwner: true });

    expect(await screen.findByText("Erin")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /actions for erin/i }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: /remove erin/i }),
    );

    // Failure path re-syncs from the server (listMembers called again) and Erin returns.
    expect(await screen.findByRole("alert")).toHaveTextContent(/last admin/i);
    await waitFor(() => expect(client.listMembers).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Erin")).toBeInTheDocument();
  });
});
