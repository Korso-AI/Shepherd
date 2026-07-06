import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { WorkspaceAnnouncementT } from "@shepherd/shared";
import { Chat } from "../../src/components/Chat.js";
import { initialsFor } from "../../src/logic.js";

/**
 * Builds a WorkspaceAnnouncementT with sensible defaults, overridden per-case.
 * Keeps each test focused on the one or two fields that drive the assertion.
 */
function announcement(
  over: Partial<WorkspaceAnnouncementT> = {},
): WorkspaceAnnouncementT {
  return {
    fromAgentName: "RedDragon",
    fromHuman: "alice",
    body: "hello team",
    targetAgentName: null,
    repo: "korso",
    fromAdmin: false,
    toAdmin: false,
    targetMemberName: null,
    createdAt: "2026-06-28T11:59:00.000Z",
    ...over,
  };
}

const NOW = Date.parse("2026-06-28T12:00:00.000Z");

describe("Chat", () => {
  it("shows the empty hint when no announcements match", () => {
    render(<Chat announcements={[]} selectedRepo={null} nowMs={NOW} />);
    expect(
      screen.getByText(/No announcements yet/),
    ).toBeInTheDocument();
  });

  it("renders a broadcast from an agent left-aligned with its initials", () => {
    render(
      <Chat
        announcements={[announcement({ fromAgentName: "RedDragon" })]}
        selectedRepo={null}
        nowMs={NOW}
      />,
    );
    const text = screen.getByText("hello team");
    const row = text.closest(".msg");
    expect(row).not.toBeNull();
    // An agent broadcast is neither "me" (right) nor targeted.
    expect(row).not.toHaveClass("msg--me");
    expect(row).not.toHaveClass("msg--targeted");
    // The avatar carries the CamelCase initials (RedDragon -> RD).
    expect(within(row as HTMLElement).getByText(initialsFor("RedDragon"))).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText("RedDragon")).toBeInTheDocument();
  });

  it("renders an operator message right-aligned (msg--me)", () => {
    render(
      <Chat
        announcements={[announcement({ fromAgentName: "admin", fromAdmin: true })]}
        selectedRepo={null}
        nowMs={NOW}
      />,
    );
    const row = screen.getByText("hello team").closest(".msg");
    expect(row).toHaveClass("msg--me");
  });

  it("renders an agent->admin message with '-> admin' and targeted styling", () => {
    render(
      <Chat
        announcements={[announcement({ toAdmin: true })]}
        selectedRepo={null}
        nowMs={NOW}
      />,
    );
    const row = screen.getByText("hello team").closest(".msg") as HTMLElement;
    expect(row).toHaveClass("msg--targeted");
    expect(within(row).getByText("→ admin")).toBeInTheDocument();
  });

  it("renders a member-directed message with the member's name, not the collective 'admin'", () => {
    render(
      <Chat
        announcements={[
          announcement({ toAdmin: true, targetMemberName: "Alice Chen" }),
        ]}
        selectedRepo={null}
        nowMs={NOW}
      />,
    );
    const row = screen.getByText("hello team").closest(".msg") as HTMLElement;
    expect(row).toHaveClass("msg--targeted");
    expect(within(row).getByText("→ @Alice Chen")).toBeInTheDocument();
    expect(within(row).queryByText("→ admin")).not.toBeInTheDocument();
  });

  it("renders a directed message with the '-> @target' header and targeted styling", () => {
    render(
      <Chat
        announcements={[announcement({ targetAgentName: "BlueWhale" })]}
        selectedRepo={null}
        nowMs={NOW}
      />,
    );
    const row = screen.getByText("hello team").closest(".msg") as HTMLElement;
    expect(row).toHaveClass("msg--targeted");
    expect(within(row).getByText("→ @BlueWhale")).toBeInTheDocument();
  });

  it("renders the time via formatRelative against nowMs", () => {
    render(
      <Chat
        announcements={[announcement({ createdAt: "2026-06-28T11:59:00.000Z" })]}
        selectedRepo={null}
        nowMs={NOW}
      />,
    );
    // 60s before NOW -> "1m ago".
    expect(screen.getByText("1m ago")).toBeInTheDocument();
  });

  it("reverses the newest-first API list to oldest->newest top->bottom", () => {
    render(
      <Chat
        announcements={[
          announcement({ body: "newest", createdAt: "2026-06-28T11:59:30.000Z" }),
          announcement({ body: "oldest", createdAt: "2026-06-28T11:50:00.000Z" }),
        ]}
        selectedRepo={null}
        nowMs={NOW}
      />,
    );
    const texts = screen
      .getAllByText(/newest|oldest/)
      .map((n) => n.textContent);
    expect(texts).toEqual(["oldest", "newest"]);
  });

  it("filters messages by the selected repo", () => {
    render(
      <Chat
        announcements={[
          announcement({ body: "in korso", repo: "korso" }),
          announcement({ body: "in other", repo: "other" }),
        ]}
        selectedRepo="korso"
        nowMs={NOW}
      />,
    );
    expect(screen.getByText("in korso")).toBeInTheDocument();
    expect(screen.queryByText("in other")).not.toBeInTheDocument();
  });
});
