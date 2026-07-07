import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  within,
  waitFor,
  act,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  WorkspaceAgentT,
  WorkspaceTaskT,
  WorkspaceLandscapeResponseT,
  WorkspaceAnnounceResponseT,
  WorkspaceSummaryT,
} from "@shepherd/shared";
import type { ShepherdClient } from "../../src/client.js";
import { ShepherdClientProvider } from "../../src/context.js";
import { Dashboard } from "../../src/components/Dashboard.js";
import { makeMockClient } from "../../src/test/mockClient.js";

/** An empty (schema-valid) landscape with zero agents. */
function emptyLandscape(): WorkspaceLandscapeResponseT {
  return { agents: [], tasks: [], announcements: [], serverTime: NOW };
}

/** Flush the immediate on-mount poll so state settles. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * Dashboard: the wallboard shell that composes useLandscapePolling + the six
 * leaf components. These tests pin BEHAVIOR — which panel is visible, the
 * persisted tab/repo, the derived repo default, and the header chrome — not the
 * internal structure, so they survive refactors of the composition itself.
 */

const NOW = "2026-06-28T12:00:00.000Z";

function agent(
  over: Partial<WorkspaceAgentT> & { name: string },
): WorkspaceAgentT {
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

function task(
  over: Partial<WorkspaceTaskT> & { agentName: string },
): WorkspaceTaskT {
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
function makeClient(snapshot: WorkspaceLandscapeResponseT): ShepherdClient {
  const ok = { ok: true as const, announcementIds: [1] };
  return {
    getLandscape: vi
      .fn<() => Promise<WorkspaceLandscapeResponseT>>()
      .mockResolvedValue(snapshot),
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
    expect(
      within(tablist).getByRole("tab", { name: "Tasks" }),
    ).toBeInTheDocument();
    expect(
      within(tablist).getByRole("tab", { name: "Chat" }),
    ).toBeInTheDocument();
    expect(
      within(tablist).queryByRole("button", { name: "Sign out" }),
    ).not.toBeInTheDocument();
  });

  it("omits the Sign out button when no logout callback is supplied", async () => {
    await renderDashboard();

    expect(
      screen.queryByRole("button", { name: "Sign out" }),
    ).not.toBeInTheDocument();
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
    expect(document.getElementById("panel-tasks")).not.toHaveAttribute(
      "hidden",
    );
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
    expect(client.announceTo).toHaveBeenCalledWith(
      "ws1",
      expect.objectContaining({ body: "hello" }),
    );
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

  it("hosted with no workspace lands on Tasks with the create-stage setup dialog open and never polls", async () => {
    const client = makeMockClient({
      landscape: vi.fn().mockResolvedValue(emptyLandscape()),
    });
    render(
      <ShepherdClientProvider client={client}>
        <Dashboard
          hasWorkspace={false}
          config={<div>config</div>}
          onWorkspacesChanged={vi.fn()}
        />
      </ShepherdClientProvider>,
    );
    await flush();

    // Lands on Tasks (not Settings), with the checklist in an open dialog.
    expect(screen.getByRole("tab", { name: "Tasks" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByRole("dialog", { name: "Setup guide" }),
    ).toBeInTheDocument();
    // The create stage keeps step 2's "Generate token" disabled.
    expect(
      screen.getByRole("button", { name: "Generate token" }),
    ).toBeDisabled();
    // No workspace → the board never polls the hub.
    expect(client.landscape).not.toHaveBeenCalled();
    expect(client.getLandscape).not.toHaveBeenCalled();
  });

  it("hosted with a workspace and no agents yet shows the connect-stage dialog over the board", async () => {
    const client = makeMockClient({
      landscape: vi.fn().mockResolvedValue(emptyLandscape()),
    });
    render(
      <ShepherdClientProvider client={client}>
        <Dashboard
          workspaceId="ws1"
          hasWorkspace={true}
          config={<div>config</div>}
          onWorkspacesChanged={vi.fn()}
        />
      </ShepherdClientProvider>,
    );
    await flush();

    expect(
      screen.getByRole("dialog", { name: "Setup guide" }),
    ).toBeInTheDocument();
    // The connect stage enables "Generate token".
    expect(
      screen.getByRole("button", { name: "Generate token" }),
    ).toBeEnabled();
    // The board renders BEHIND the dialog — the guide no longer replaces it.
    expect(document.getElementById("crew")).toBeInTheDocument();
  });

  it("hosted with agents present shows the board and never flashes the checklist", async () => {
    const client = makeMockClient({
      landscape: vi.fn().mockResolvedValue(makeSnapshot()),
    });
    render(
      <ShepherdClientProvider client={client}>
        <Dashboard
          workspaceId="ws1"
          hasWorkspace={true}
          config={<div>config</div>}
          onWorkspacesChanged={vi.fn()}
        />
      </ShepherdClientProvider>,
    );
    // First render (snapshot still null) must not show the dialog.
    expect(
      screen.queryByRole("dialog", { name: "Setup guide" }),
    ).not.toBeInTheDocument();

    await flush();

    expect(
      screen.queryByRole("dialog", { name: "Setup guide" }),
    ).not.toBeInTheDocument();
    expect(document.getElementById("crew")).toBeInTheDocument();
    expect(screen.getByText("wire the b feature")).toBeInTheDocument();
  });

  it("skips to the board, persists per-workspace, and reopens via the ? header button", async () => {
    const user = userEvent.setup();
    const props = {
      workspaceId: "ws1",
      hasWorkspace: true,
      config: <div>config</div>,
      onWorkspacesChanged: vi.fn(),
    };
    const client = makeMockClient({
      landscape: vi.fn().mockResolvedValue(emptyLandscape()),
    });
    const { unmount } = render(
      <ShepherdClientProvider client={client}>
        <Dashboard {...props} />
      </ShepherdClientProvider>,
    );
    await flush();

    expect(
      screen.getByRole("dialog", { name: "Setup guide" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Skip for now" }));

    // Dialog closed, skip persisted for THIS workspace, board still up.
    expect(
      screen.queryByRole("dialog", { name: "Setup guide" }),
    ).not.toBeInTheDocument();
    expect(document.getElementById("crew")).toBeInTheDocument();
    expect(localStorage.getItem("shepherd.setup.skipped.ws1")).not.toBeNull();

    // The persistent ? header button re-opens the guide.
    await user.click(screen.getByRole("button", { name: "Setup guide" }));
    expect(
      screen.getByRole("dialog", { name: "Setup guide" }),
    ).toBeInTheDocument();

    unmount();

    // Remount: the persisted skip keeps the checklist hidden.
    const client2 = makeMockClient({
      landscape: vi.fn().mockResolvedValue(emptyLandscape()),
    });
    render(
      <ShepherdClientProvider client={client2}>
        <Dashboard {...props} />
      </ShepherdClientProvider>,
    );
    await flush();
    expect(
      screen.queryByRole("dialog", { name: "Setup guide" }),
    ).not.toBeInTheDocument();
    expect(document.getElementById("crew")).toBeInTheDocument();
  });

  it("self-host (no hasWorkspace) renders no setup dialog or ? header button", async () => {
    await renderDashboard();

    expect(
      screen.queryByRole("dialog", { name: "Setup guide" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Setup guide" }),
    ).not.toBeInTheDocument();
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

// ---------------------------------------------------------------------------
// Dashboard — hosted-shell setup-checklist wiring: the connect-stage step 1
// summary and the per-workspace-switch reset of the in-memory skip/force flags.
// DB-free: the mock ShepherdClient is injected via ShepherdClientProvider.
// ---------------------------------------------------------------------------

const HUB_URL = "https://hub.example.run.app";
const WS: WorkspaceSummaryT = {
  id: "ws_1",
  slug: "acme",
  name: "Acme",
  role: "admin",
};
const WS2: WorkspaceSummaryT = {
  id: "ws_2",
  slug: "beta",
  name: "Beta",
  role: "admin",
};

describe("Dashboard setup checklist", () => {
  let client: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    // The board persists its tab + the per-workspace skip flag; clear so each
    // test starts from the default landing and an un-skipped checklist.
    localStorage.clear();
    client = makeMockClient();
  });

  function renderChecklistDashboard(
    props: Partial<Parameters<typeof Dashboard>[0]> = {},
  ) {
    return render(
      <ShepherdClientProvider client={client}>
        <Dashboard
          hasWorkspace
          hubUrl={HUB_URL}
          onWorkspacesChanged={vi.fn()}
          {...props}
        />
      </ShepherdClientProvider>,
    );
  }

  it("connect stage renders step 1 as the checked workspace summary, not a create form", async () => {
    // A workspace with no agents yet (empty snapshot) → the connect stage.
    renderChecklistDashboard({ workspaceId: "ws_1", workspace: WS });

    // Step 1 shows the workspace name (checked), and the create form is gone.
    await screen.findByText(/waiting for your agent to check in/i);
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.queryByLabelText(/workspace name/i)).not.toBeInTheDocument();
  });

  it("resets the in-memory skip when the workspace changes (no cross-switch leak)", async () => {
    const { rerender } = renderChecklistDashboard({
      workspaceId: "ws_1",
      workspace: WS,
    });

    // ws_1: the connect-stage checklist renders; skip it.
    await screen.findByRole("dialog", { name: /setup guide/i });
    await userEvent.click(
      screen.getByRole("button", { name: /skip for now/i }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: /setup guide/i }),
      ).not.toBeInTheDocument(),
    );

    // Switch to ws_2 (Dashboard stays mounted, only workspaceId changes). The
    // in-memory sessionSkipped flag must NOT leak: ws_2 was never skipped, so
    // its checklist returns.
    rerender(
      <ShepherdClientProvider client={client}>
        <Dashboard
          hasWorkspace
          hubUrl={HUB_URL}
          onWorkspacesChanged={vi.fn()}
          workspaceId="ws_2"
          workspace={WS2}
        />
      </ShepherdClientProvider>,
    );

    await screen.findByRole("dialog", { name: /setup guide/i });
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("never derives the checklist stage (or agent names) from the previous workspace's retained snapshot", async () => {
    // ws_1 has a checked-in agent; ws_2 is brand new (empty landscape). The
    // polling hook RETAINS ws_1's snapshot across the switch — the checklist
    // must not read it as ws_2's: no "wolf checked in." from the old
    // workspace, and the connect stage appears only once ws_2's poll lands.
    const wolf: WorkspaceAgentT = {
      name: "wolf",
      human: "Ada",
      program: "claude-code",
      model: null,
      repo: null,
      branch: null,
      lastHeartbeatAt: NOW,
      presence: "live",
    };
    let currentWs = "ws_1";
    let releaseWs2!: () => void;
    const ws2Poll = new Promise<void>((r) => {
      releaseWs2 = r;
    });
    client.landscape = vi.fn().mockImplementation(async (id: string) => {
      if (id === "ws_2") {
        await ws2Poll;
        return { ...emptyLandscape() };
      }
      return { ...emptyLandscape(), agents: [wolf] };
    });

    const { rerender } = renderChecklistDashboard({
      workspaceId: currentWs,
      workspace: WS,
    });
    // ws_1 is established (has an agent): no checklist.
    await flush();
    expect(
      screen.queryByRole("dialog", { name: /setup guide/i }),
    ).not.toBeInTheDocument();

    // Switch to the empty ws_2; its poll has NOT resolved yet.
    currentWs = "ws_2";
    rerender(
      <ShepherdClientProvider client={client}>
        <Dashboard
          hasWorkspace
          hubUrl={HUB_URL}
          onWorkspacesChanged={vi.fn()}
          workspaceId="ws_2"
          workspace={WS2}
        />
      </ShepherdClientProvider>,
    );

    // The retained ws_1 snapshot keeps the BOARD up (documented never-blank
    // behavior) but must not leak into the checklist: no checklist renders and
    // no "checked in" indicator names ws_1's agent while ws_2's first poll is
    // in flight.
    expect(
      screen.queryByRole("dialog", { name: /setup guide/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/wolf checked in/)).not.toBeInTheDocument();

    releaseWs2();
    await flush();

    // ws_2's own (empty) poll landed → the connect-stage checklist, waiting.
    await screen.findByRole("dialog", { name: /setup guide/i });
    expect(
      screen.getByText(/waiting for your agent to check in/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/wolf checked in/)).not.toBeInTheDocument();
  });

  it("keeps the checklist up through the first agent check-in until 'Go to your board'", async () => {
    // The success state must be reachable: when the first agent appears in a
    // poll, the engaged guide holds at connect (showing "checked in") instead
    // of instantly unmounting; the operator dismisses it themselves.
    const wolf: WorkspaceAgentT = {
      name: "wolf",
      human: "Ada",
      program: "claude-code",
      model: null,
      repo: null,
      branch: null,
      lastHeartbeatAt: NOW,
      presence: "live",
    };
    let agents: WorkspaceAgentT[] = [];
    client.landscape = vi
      .fn()
      .mockImplementation(async () => ({ ...emptyLandscape(), agents }));

    renderChecklistDashboard({ workspaceId: "ws_1", workspace: WS });
    await screen.findByText(/waiting for your agent to check in/i);

    // The first agent checks in on a later poll (driven here via refresh —
    // the composer's post-send hook shares the same poll path).
    agents = [wolf];
    await userEvent.click(screen.getByRole("tab", { name: "Chat" }));
    await userEvent.type(screen.getByLabelText("Message the team"), "hi");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await userEvent.click(screen.getByRole("tab", { name: "Tasks" }));

    // Checklist still up, now showing the success state.
    await screen.findByText(/wolf checked in/i);
    expect(
      screen.getByRole("dialog", { name: /setup guide/i }),
    ).toBeInTheDocument();

    // Dismiss → the real board.
    await userEvent.click(
      screen.getByRole("button", { name: /go to your board/i }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: /setup guide/i }),
      ).not.toBeInTheDocument(),
    );
    expect(document.getElementById("crew")).toBeInTheDocument();
  });

  it("the ✕ close button dismisses the dialog and persists the per-workspace skip", async () => {
    renderChecklistDashboard({ workspaceId: "ws_1", workspace: WS });
    await screen.findByRole("dialog", { name: /setup guide/i });

    await userEvent.click(
      screen.getByRole("button", { name: /close setup guide/i }),
    );

    expect(
      screen.queryByRole("dialog", { name: /setup guide/i }),
    ).not.toBeInTheDocument();
    expect(localStorage.getItem("shepherd.setup.skipped.ws_1")).not.toBeNull();
  });

  it("Escape dismisses the dialog", async () => {
    renderChecklistDashboard({ workspaceId: "ws_1", workspace: WS });
    await screen.findByRole("dialog", { name: /setup guide/i });

    await userEvent.keyboard("{Escape}");

    expect(
      screen.queryByRole("dialog", { name: /setup guide/i }),
    ).not.toBeInTheDocument();
  });

  it("a backdrop click dismisses the dialog; clicks inside do not", async () => {
    renderChecklistDashboard({ workspaceId: "ws_1", workspace: WS });
    const dialog = await screen.findByRole("dialog", { name: /setup guide/i });

    // A click INSIDE the dialog must not close it.
    fireEvent.click(dialog);
    expect(
      screen.getByRole("dialog", { name: /setup guide/i }),
    ).toBeInTheDocument();

    const backdrop = document.querySelector(".shepherd-modal__backdrop");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);

    expect(
      screen.queryByRole("dialog", { name: /setup guide/i }),
    ).not.toBeInTheDocument();
  });

  it("the create stage (no workspace) is dismissible and re-openable via the ? button", async () => {
    renderChecklistDashboard({ hasWorkspace: false });
    await screen.findByRole("dialog", { name: /setup guide/i });

    // Closing works even before a workspace exists (session-only: there is no
    // workspace id to persist a skip against).
    await userEvent.click(
      screen.getByRole("button", { name: /close setup guide/i }),
    );
    expect(
      screen.queryByRole("dialog", { name: /setup guide/i }),
    ).not.toBeInTheDocument();
    expect(localStorage.length).toBe(0);

    // The ? header button brings it back at the create stage.
    await userEvent.click(screen.getByRole("button", { name: "Setup guide" }));
    const dialog = screen.getByRole("dialog", { name: /setup guide/i });
    expect(
      within(dialog).getByLabelText(/workspace name/i),
    ).toBeInTheDocument();
  });
});
