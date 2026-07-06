import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  WorkspaceAgentT,
  WorkspaceTaskT,
  WorkspaceLandscapeResponseT,
  WorkspaceAnnounceResponseT,
} from "@shepherd/shared";
import type { ShepherdClient } from "../../src/client.js";
import { ShepherdClientProvider } from "../../src/context.js";
import { Dashboard } from "../../src/components/Dashboard.js";

/**
 * Dashboard: the wallboard shell that composes useLandscapePolling + the six
 * leaf components. These tests pin BEHAVIOR — which panel is visible, the
 * persisted tab/repo, the derived repo default, and the header chrome — not the
 * internal structure, so they survive refactors of the composition itself.
 */

const NOW = "2026-06-28T12:00:00.000Z";

function agent(over: Partial<WorkspaceAgentT> & { name: string }): WorkspaceAgentT {
  return {
    name: over.name,
    human: over.human ?? "human",
    program: over.program ?? "claude",
    model: over.model ?? null,
    repo: over.repo ?? "korso/a",
    branch: over.branch ?? null,
    lastHeartbeatAt: over.lastHeartbeatAt ?? NOW,
    presence: over.presence ?? "live",
  };
}

function task(over: Partial<WorkspaceTaskT> & { agentName: string }): WorkspaceTaskT {
  return {
    agentName: over.agentName,
    program: over.program ?? "claude",
    model: over.model ?? null,
    repo: over.repo ?? "korso/a",
    intent: over.intent ?? "doing work",
    pathGlobs: over.pathGlobs ?? ["src/**"],
    status: over.status ?? "active",
    createdAt: over.createdAt ?? "2026-06-28T10:00:00.000Z",
    endedAt: over.endedAt ?? null,
  };
}

/**
 * A multi-repo snapshot. Newest-first tasks (the contract assumed by
 * defaultRepo): the newest ACTIVE task is in "korso/b", so the first-load
 * default repo is "korso/b".
 */
function makeSnapshot(): WorkspaceLandscapeResponseT {
  return {
    agents: [
      agent({ name: "RedDragon", repo: "korso/b", presence: "live" }),
      agent({ name: "BlueWhale", repo: "korso/a", presence: "live" }),
      agent({ name: "GreyMoth", repo: "korso/a", presence: "offline" }),
    ],
    tasks: [
      // newest-first
      task({
        agentName: "RedDragon",
        repo: "korso/b",
        intent: "wire the b feature",
        status: "active",
        createdAt: "2026-06-28T11:30:00.000Z",
      }),
      task({
        agentName: "BlueWhale",
        repo: "korso/a",
        intent: "wire the a feature",
        status: "active",
        createdAt: "2026-06-28T11:00:00.000Z",
      }),
      task({
        agentName: "GreyMoth",
        repo: "korso/a",
        intent: "old a work",
        status: "done",
        createdAt: "2026-06-28T09:00:00.000Z",
        endedAt: "2026-06-28T09:30:00.000Z",
      }),
    ],
    announcements: [
      {
        fromAgentName: "RedDragon",
        fromHuman: "alice",
        body: "hello team",
        targetAgentName: null,
        repo: "korso/b",
        fromAdmin: false,
        toAdmin: false,
        targetMemberName: null,
        createdAt: "2026-06-28T11:45:00.000Z",
      },
    ],
    serverTime: NOW,
  };
}

/**
 * A client whose BOTH landscape routes resolve the given snapshot and BOTH
 * announce routes are noop oks. The hook picks `landscape(id)` vs the singular
 * `getLandscape()` from the supplied `workspaceId`, and the composer picks
 * `announceTo`/`announce` likewise — so the tests assert WHICH route ran.
 */
function makeClient(
  snapshot: WorkspaceLandscapeResponseT,
): ShepherdClient {
  const ok = { ok: true as const, announcementIds: [1] };
  return {
    getLandscape: vi.fn<() => Promise<WorkspaceLandscapeResponseT>>().mockResolvedValue(snapshot),
    landscape: vi
      .fn<(id: string) => Promise<WorkspaceLandscapeResponseT>>()
      .mockResolvedValue(snapshot),
    announce: vi
      .fn<() => Promise<WorkspaceAnnounceResponseT>>()
      .mockResolvedValue(ok),
    announceTo: vi
      .fn<() => Promise<WorkspaceAnnounceResponseT>>()
      .mockResolvedValue(ok),
  };
}

/** Renders the Dashboard under the client provider and flushes the on-mount poll. */
async function renderDashboard(
  snapshot = makeSnapshot(),
  workspaceId?: string,
  onLogout?: () => void,
) {
  const client = makeClient(snapshot);
  const view = render(
    <ShepherdClientProvider client={client}>
      <Dashboard workspaceId={workspaceId} onLogout={onLogout} />
    </ShepherdClientProvider>,
  );
  // Flush the immediate-on-mount poll so the snapshot renders.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return { client, ...view };
}

describe("Dashboard", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("renders the brand, status indicator, vitals, and tabs in the header", async () => {
    await renderDashboard();

    expect(screen.getByText("Shepherd")).toBeInTheDocument();
    // Status maps the hook's "live" to the .status--ok indicator.
    const status = document.querySelector(".status");
    expect(status).not.toBeNull();
    expect(status).toHaveTextContent("live");
    // Vitals show online + active counts.
    expect(document.querySelector(".vitals")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Chat" })).toBeInTheDocument();
  });

  it("renders the optional Sign out header button outside the tablist", async () => {
    const user = userEvent.setup();
    const onLogout = vi.fn();
    await renderDashboard(makeSnapshot(), undefined, onLogout);

    const signOut = screen.getByRole("button", { name: "Sign out" });
    await user.click(signOut);

    expect(onLogout).toHaveBeenCalledTimes(1);
    const tablist = screen.getByRole("tablist", { name: "Shepherd views" });
    expect(within(tablist).getByRole("tab", { name: "Tasks" })).toBeInTheDocument();
    expect(within(tablist).getByRole("tab", { name: "Chat" })).toBeInTheDocument();
    expect(within(tablist).queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it("omits the Sign out button when no logout callback is supplied", async () => {
    await renderDashboard();

    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it("defaults to the newest-active repo's view when >=2 repos and no persisted selection", async () => {
    await renderDashboard();

    // Default repo is "korso/b" (newest active task). Its active card shows, the
    // other repo's active card does not.
    expect(screen.getByText("wire the b feature")).toBeInTheDocument();
    expect(screen.queryByText("wire the a feature")).not.toBeInTheDocument();

    // Vitals reflect korso/b only: 1 online (RedDragon), 1 active.
    const vitals = document.querySelector(".vitals");
    expect(vitals).toHaveTextContent("1");
    const online = document.getElementById("vitals-online");
    const activeN = document.getElementById("vitals-active");
    expect(online).toHaveTextContent("1");
    expect(activeN).toHaveTextContent("1");
  });

  it("shows the active/done column-count badges for the current filter", async () => {
    const user = userEvent.setup();
    await renderDashboard();

    // Default repo korso/b: 1 active, 0 done.
    expect(document.getElementById("active-count")).toHaveTextContent("1");
    expect(document.getElementById("done-count")).toHaveTextContent("0");

    // Switch to All repos: 2 active, 1 done across both repos.
    await user.click(screen.getByRole("button", { name: /Filter by repo/ }));
    await user.click(screen.getByRole("option", { name: /All repos/ }));
    expect(document.getElementById("active-count")).toHaveTextContent("2");
    expect(document.getElementById("done-count")).toHaveTextContent("1");
  });

  it("starts on the tasks tab showing crew + active/done content", async () => {
    await renderDashboard();

    // Tasks panel visible, chat panel hidden.
    const tasksPanel = document.getElementById("panel-tasks");
    const chatPanel = document.getElementById("panel-chat");
    expect(tasksPanel).not.toHaveAttribute("hidden");
    expect(chatPanel).toHaveAttribute("hidden");
    // Active column content present.
    expect(screen.getByText("wire the b feature")).toBeInTheDocument();
    // Crew rail present.
    expect(document.getElementById("crew")).toBeInTheDocument();
  });

  it("switching to the chat tab shows the composer and persists 'shepherd.tab'", async () => {
    const user = userEvent.setup();
    await renderDashboard();

    await user.click(screen.getByRole("tab", { name: "Chat" }));

    const chatPanel = document.getElementById("panel-chat");
    const tasksPanel = document.getElementById("panel-tasks");
    expect(chatPanel).not.toHaveAttribute("hidden");
    expect(tasksPanel).toHaveAttribute("hidden");
    // Composer present on the chat tab.
    expect(screen.getByLabelText("Message the team")).toBeInTheDocument();
    // Persisted.
    expect(localStorage.getItem("shepherd.tab")).toBe("chat");

    // And back to tasks persists too.
    await user.click(screen.getByRole("tab", { name: "Tasks" }));
    expect(localStorage.getItem("shepherd.tab")).toBe("tasks");
    expect(document.getElementById("panel-tasks")).not.toHaveAttribute("hidden");
  });

  it("honors a persisted 'shepherd.tab' of chat on first render", async () => {
    localStorage.setItem("shepherd.tab", "chat");
    await renderDashboard();

    expect(document.getElementById("panel-chat")).not.toHaveAttribute("hidden");
    expect(screen.getByLabelText("Message the team")).toBeInTheDocument();
  });

  it("persists the repo selection and refilters when a repo is picked", async () => {
    const user = userEvent.setup();
    await renderDashboard();

    // Open the repo selector and choose "All repos".
    const trigger = screen.getByRole("button", { name: /Filter by repo/ });
    await user.click(trigger);
    const allOption = screen.getByRole("option", { name: /All repos/ });
    await user.click(allOption);

    expect(localStorage.getItem("shepherd.repo")).toBe("__all__");
    // All-repos view shows both active cards.
    expect(screen.getByText("wire the b feature")).toBeInTheDocument();
    expect(screen.getByText("wire the a feature")).toBeInTheDocument();
  });

  it("polls the workspace-scoped landscape(id) and announces via announceTo when given a workspaceId", async () => {
    const user = userEvent.setup();
    const { client } = await renderDashboard(makeSnapshot(), "ws1");

    // The hook hit the plural, scoped route — not the singular alias.
    expect(client.landscape).toHaveBeenCalledWith("ws1");
    expect(client.getLandscape).not.toHaveBeenCalled();
    // The board still renders off the snapshot.
    expect(screen.getByText("wire the b feature")).toBeInTheDocument();

    // Submitting the composer routes through announceTo("ws1", …).
    await user.click(screen.getByRole("tab", { name: "Chat" }));
    const input = screen.getByLabelText("Message the team");
    await user.type(input, "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(client.announceTo).toHaveBeenCalledTimes(1));
    expect(client.announceTo).toHaveBeenCalledWith("ws1", expect.objectContaining({ body: "hello" }));
    expect(client.announce).not.toHaveBeenCalled();
  });

  it("polls the singular getLandscape() and announces via announce in the self-host (no workspaceId) case", async () => {
    const user = userEvent.setup();
    const { client } = await renderDashboard();

    // No workspaceId → the singular self-host alias, not the scoped route.
    expect(client.getLandscape).toHaveBeenCalled();
    expect(client.landscape).not.toHaveBeenCalled();
    expect(screen.getByText("wire the b feature")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Chat" }));
    const input = screen.getByLabelText("Message the team");
    await user.type(input, "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(client.announce).toHaveBeenCalledTimes(1));
    expect(client.announceTo).not.toHaveBeenCalled();
  });

  it("renders a loading/empty state when there is no snapshot yet", () => {
    // A client that never resolves: snapshot stays null.
    const client: ShepherdClient = {
      getLandscape: vi
        .fn<() => Promise<WorkspaceLandscapeResponseT>>()
        .mockReturnValue(new Promise<WorkspaceLandscapeResponseT>(() => {})),
      announce: vi
        .fn<() => Promise<WorkspaceAnnounceResponseT>>()
        .mockResolvedValue({ ok: true, announcementIds: [1] }),
    };
    render(
      <ShepherdClientProvider client={client}>
        <Dashboard />
      </ShepherdClientProvider>,
    );
    // No crash; the brand still shows even before the first snapshot.
    expect(screen.getByText("Shepherd")).toBeInTheDocument();
  });
});
