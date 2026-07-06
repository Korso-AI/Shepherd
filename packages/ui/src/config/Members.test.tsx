import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ShepherdClientProvider } from "../context.js";
import { Members } from "./Members.js";
import { makeMockClient } from "../test/mockClient.js";

// ---------------------------------------------------------------------------
// Members — the workspace roster. Fetches the list on mount (and whenever
// refreshKey changes) and removes a member through the client when the caller
// permits it. Rejections surface as a visible alert. (Self-service "leave" now
// lives in <GeneralSettings> — see GeneralSettings.test.tsx.)
// ---------------------------------------------------------------------------

const WORKSPACE_ID = "ws_1";

describe("Members", () => {
  let client: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    client = makeMockClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderMembers(
    props?: Partial<{ refreshKey: number; canRemove: boolean }>,
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
        {
          accountId: "acc_1",
          displayName: "Alice",
          githubLogin: "alice",
          email: null,
          avatarUrl: null,
          role: "admin",
        },
      ],
    });

    renderMembers();

    await waitFor(() => expect(client.listMembers).toHaveBeenCalledWith(WORKSPACE_ID));
    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("admin")).toBeInTheDocument();
  });

  it("falls back to email, then the account id, when name/login are absent", async () => {
    client.listMembers = vi.fn().mockResolvedValue({
      members: [
        {
          accountId: "acc_email",
          displayName: null,
          githubLogin: null,
          email: "dana@example.com",
          avatarUrl: null,
          role: "admin",
        },
        {
          accountId: "acc_bare",
          displayName: null,
          githubLogin: null,
          email: null,
          avatarUrl: null,
          role: "member",
        },
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
        {
          accountId: "acc_2",
          displayName: "Bob",
          githubLogin: "bob",
          email: null,
          avatarUrl: null,
          role: "member",
        },
      ],
    });
    client.removeMember = vi.fn().mockResolvedValue(undefined);

    renderMembers({ canRemove: true });

    expect(await screen.findByText("Bob")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /remove/i }));

    await waitFor(() =>
      expect(client.removeMember).toHaveBeenCalledWith(WORKSPACE_ID, "acc_2"),
    );
    // Optimistically dropped from the list.
    await waitFor(() => expect(screen.queryByText("Bob")).not.toBeInTheDocument());
  });

  it("surfaces an error when removeMember is rejected (e.g. last-admin guard)", async () => {
    client.listMembers = vi.fn().mockResolvedValue({
      members: [
        {
          accountId: "acc_3",
          displayName: "Carol",
          githubLogin: "carol",
          email: null,
          avatarUrl: null,
          role: "admin",
        },
      ],
    });
    client.removeMember = vi
      .fn()
      .mockRejectedValue(new Error("cannot remove the last admin"));

    renderMembers({ canRemove: true });

    expect(await screen.findByText("Carol")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /remove/i }));

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
        {
          accountId: "acc_9",
          displayName: "Dave",
          githubLogin: "dave",
          email: null,
          avatarUrl: null,
          role: "member",
        },
      ],
    });
    let resolve!: () => void;
    client.removeMember = vi.fn().mockReturnValue(
      new Promise<void>((r) => {
        resolve = r;
      }),
    );

    renderMembers({ canRemove: true });

    const removeBtn = await screen.findByRole("button", { name: /remove dave/i });
    await userEvent.click(removeBtn);

    // Optimistically dropped, so the button is gone; resolving completes cleanly.
    await waitFor(() => expect(client.removeMember).toHaveBeenCalledTimes(1));
    resolve();
    expect(await screen.findByRole("status")).toHaveTextContent(/removed dave/i);
  });

  it("recovers the roster from the server when a remove is rejected", async () => {
    const members = [
      {
        accountId: "acc_e",
        displayName: "Erin",
        githubLogin: "erin",
        email: null,
        avatarUrl: null,
        role: "admin",
      },
    ];
    client.listMembers = vi.fn().mockResolvedValue({ members });
    client.removeMember = vi.fn().mockRejectedValue(new Error("cannot remove the last admin"));

    renderMembers({ canRemove: true });

    expect(await screen.findByText("Erin")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /remove erin/i }));

    // Failure path re-syncs from the server (listMembers called again) and Erin returns.
    expect(await screen.findByRole("alert")).toHaveTextContent(/last admin/i);
    await waitFor(() => expect(client.listMembers).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Erin")).toBeInTheDocument();
  });
});
