import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { WorkspaceAgentT, WorkspaceSummaryT } from "@shepherd/shared";
import { ShepherdClientProvider } from "../context.js";
import { SetupChecklist } from "./SetupChecklist.js";
import { makeMockClient } from "../test/mockClient.js";

// ---------------------------------------------------------------------------
// SetupChecklist — first-run two-step panel + post-token cards rail. DB-free:
// the mock ShepherdClient is injected via ShepherdClientProvider's `client`
// prop.
// ---------------------------------------------------------------------------

const WS: WorkspaceSummaryT = {
  id: "ws_1",
  slug: "acme",
  name: "Acme",
  role: "admin",
};

function makeAgent(over: Partial<WorkspaceAgentT> = {}): WorkspaceAgentT {
  return {
    name: "wolf",
    human: "Ada",
    program: "claude-code",
    model: null,
    repo: null,
    branch: null,
    lastHeartbeatAt: "2026-07-06T00:00:00.000Z",
    presence: "live",
    ...over,
  };
}

describe("SetupChecklist", () => {
  const HUB_URL = "https://hub.example.run.app";
  let client: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    client = makeMockClient();
    // The panel persists the token-minted milestone; isolate tests from it.
    localStorage.clear();
    // jsdom has no Clipboard implementation; stub it so the copy button works.
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  function renderPanel(
    props: Partial<Parameters<typeof SetupChecklist>[0]> = {},
  ) {
    const merged = {
      stage: "create" as const,
      workspace: null,
      agents: null,
      hubUrl: HUB_URL,
      onWorkspacesChanged: vi.fn(),
      onSkip: vi.fn(),
      ...props,
    };
    const utils = render(
      <ShepherdClientProvider client={client}>
        <SetupChecklist {...merged} />
      </ShepherdClientProvider>,
    );
    return { ...utils, props: merged };
  }

  it("keeps Generate token disabled until a workspace name is entered (create stage)", async () => {
    renderPanel();

    expect(
      screen.getByRole("button", { name: /generate token/i }),
    ).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/workspace name/i), "Acme");

    expect(
      screen.getByRole("button", { name: /generate token/i }),
    ).toBeEnabled();
  });

  it("lights up step 2 as soon as a workspace name is typed (create stage)", async () => {
    renderPanel();
    const step2 = screen
      .getByRole("button", { name: /generate token/i })
      .closest(".shepherd-setup__step");

    // Empty name: step 2 reads as a muted future step.
    expect(step2).not.toHaveClass("shepherd-setup__step--armed");

    await userEvent.type(screen.getByLabelText(/workspace name/i), "Acme");

    // A name makes the one-click button actionable, so the whole step comes
    // to full visual strength — the button must not LOOK disabled.
    expect(step2).toHaveClass("shepherd-setup__step--armed");
  });

  it("creates the workspace with the trimmed name, then mints a token, in one click", async () => {
    const onWorkspacesChanged = vi.fn();
    client.mintAccountToken = vi
      .fn()
      .mockResolvedValue({ token: "shp_realtoken123", id: "tok_1" });
    renderPanel({ onWorkspacesChanged });

    await userEvent.type(screen.getByLabelText(/workspace name/i), "  Acme  ");
    await userEvent.click(
      screen.getByRole("button", { name: /generate token/i }),
    );

    await waitFor(() =>
      expect(client.createWorkspace).toHaveBeenCalledWith({ name: "Acme" }),
    );
    expect(onWorkspacesChanged).toHaveBeenCalledTimes(1);
    // The same click mints the token and renders it in the install command.
    await waitFor(() =>
      expect(screen.getByTestId("setup-install-command").textContent).toContain(
        "shp_realtoken123",
      ),
    );
    expect(client.mintAccountToken).toHaveBeenCalledWith({
      name: "Acme agent",
    });
  });

  it("surfaces a create error, mints nothing, and keeps the form for a retry", async () => {
    client.createWorkspace = vi
      .fn()
      .mockRejectedValue(new Error("Name already taken"));
    renderPanel();

    await userEvent.type(screen.getByLabelText(/workspace name/i), "Acme");
    await userEvent.click(
      screen.getByRole("button", { name: /generate token/i }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Name already taken",
    );
    // Form still present for a retry, and no token was minted after the failure.
    expect(screen.getByLabelText(/workspace name/i)).toBeInTheDocument();
    expect(client.mintAccountToken).not.toHaveBeenCalled();
  });

  it("creates the workspace only once when Generate token is clicked again before the stage swaps", async () => {
    renderPanel();
    const button = () =>
      screen.getByRole("button", { name: /generate token/i });

    await userEvent.type(screen.getByLabelText(/workspace name/i), "Acme");
    await userEvent.click(button());
    await waitFor(() =>
      expect(client.createWorkspace).toHaveBeenCalledTimes(1),
    );

    // The caller's re-list hasn't swapped the stage to "connect" yet. A second
    // click must re-mint (a retry) but must NOT create a duplicate workspace.
    await userEvent.click(button());
    await waitFor(() =>
      expect(client.mintAccountToken).toHaveBeenCalledTimes(2),
    );
    expect(client.createWorkspace).toHaveBeenCalledTimes(1);
  });

  it("surfaces a token-mint error for a retry", async () => {
    client.mintAccountToken = vi
      .fn()
      .mockRejectedValue(new Error("Too many tokens"));
    renderPanel({ stage: "connect", workspace: WS, agents: [] });

    await userEvent.click(
      screen.getByRole("button", { name: /generate token/i }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many tokens",
    );
    // The mint button is re-enabled for a retry.
    expect(
      screen.getByRole("button", { name: /generate token/i }),
    ).toBeEnabled();
  });

  it("connect stage: shows step 1 done and waits for an agent, then checks off when one appears", () => {
    const { rerender } = renderPanel({
      stage: "connect",
      workspace: WS,
      agents: [],
    });

    // Step 1 checked, naming the workspace.
    expect(screen.getByText("Acme")).toBeInTheDocument();
    // Live indicator waiting.
    expect(screen.getByText(/waiting for your agent/i)).toBeInTheDocument();

    rerender(
      <ShepherdClientProvider client={client}>
        <SetupChecklist
          stage="connect"
          workspace={WS}
          agents={[makeAgent({ name: "wolf" })]}
          hubUrl={HUB_URL}
          onWorkspacesChanged={vi.fn()}
          onSkip={vi.fn()}
        />
      </ShepherdClientProvider>,
    );

    expect(
      screen.queryByText(/waiting for your agent/i),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/wolf checked in/)).toBeInTheDocument();
  });

  it("offers a 'Go to your board' dismissal once the agent has checked in", async () => {
    const onSkip = vi.fn();
    renderPanel({
      stage: "connect",
      workspace: WS,
      agents: [makeAgent()],
      onSkip,
    });

    await userEvent.click(
      screen.getByRole("button", { name: /go to your board/i }),
    );
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("drops the raw token from the install command once the agent checks in", async () => {
    client.mintAccountToken = vi
      .fn()
      .mockResolvedValue({ token: "shp_realtoken123", id: "tok_1" });
    const { rerender } = renderPanel({
      stage: "connect",
      workspace: WS,
      agents: [],
    });

    await userEvent.click(
      screen.getByRole("button", { name: /generate token/i }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("setup-install-command").textContent).toContain(
        "shp_realtoken123",
      ),
    );

    // The first agent checks in: the live bearer token must leave the DOM.
    rerender(
      <ShepherdClientProvider client={client}>
        <SetupChecklist
          stage="connect"
          workspace={WS}
          agents={[makeAgent()]}
          hubUrl={HUB_URL}
          onWorkspacesChanged={vi.fn()}
          onSkip={vi.fn()}
        />
      </ShepherdClientProvider>,
    );

    await waitFor(() =>
      expect(
        screen.getByTestId("setup-install-command").textContent,
      ).not.toContain("shp_realtoken123"),
    );
  });

  it("prefers a live agent name over an offline one for the check-in indicator", () => {
    renderPanel({
      stage: "connect",
      workspace: WS,
      agents: [
        makeAgent({ name: "sleepy", presence: "offline" }),
        makeAgent({ name: "awake", presence: "live" }),
      ],
    });
    expect(screen.getByText(/awake/)).toBeInTheDocument();
  });

  it("mints an account token and renders the install command with token and hub URL", async () => {
    client.mintAccountToken = vi
      .fn()
      .mockResolvedValue({ token: "shp_realtoken123", id: "tok_1" });
    renderPanel({ stage: "connect", workspace: WS, agents: [] });

    await userEvent.click(
      screen.getByRole("button", { name: /generate token/i }),
    );

    await waitFor(() => {
      const cmd = screen.getByTestId("setup-install-command").textContent ?? "";
      expect(cmd).toContain("shp_realtoken123");
      expect(cmd).toContain(HUB_URL);
    });
    expect(client.mintAccountToken).toHaveBeenCalledWith({
      name: "Acme agent",
    });
  });

  it("marks the text copy button for welcome-panel spacing", () => {
    renderPanel({ stage: "connect", workspace: WS, agents: [] });

    expect(screen.getByRole("button", { name: /copy command/i })).toHaveClass(
      "shepherd-setup__copy",
    );
  });

  it("swaps the install command when a different tool is picked", async () => {
    renderPanel({ stage: "connect", workspace: WS, agents: [] });

    await userEvent.selectOptions(screen.getByLabelText(/tool/i), "codex");
    await waitFor(() => {
      const cmd = screen.getByTestId("setup-install-command").textContent ?? "";
      expect(cmd).toMatch(/codex mcp add/);
      expect(cmd).toContain("PROGRAM=codex");
    });
  });

  it("shows the npm install as its own copyable command for JSON-config tools", async () => {
    renderPanel({ stage: "connect", workspace: WS, agents: [] });

    // A JSON block can't embed a shell command, so the install prerequisite
    // gets its own box above it.
    await userEvent.selectOptions(screen.getByLabelText(/tool/i), "pi");
    expect(screen.getByTestId("setup-install-prereq")).toHaveTextContent(
      "npm install -g @korso/shepherd",
    );
    expect(
      screen.getByTestId("setup-install-command").textContent,
    ).not.toContain("npx");

    await userEvent.click(
      screen.getByRole("button", { name: /copy install command/i }),
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "npm install -g @korso/shepherd",
    );

    // CLI tools embed the install as the command's first line — no extra box.
    await userEvent.selectOptions(screen.getByLabelText(/tool/i), "claude");
    expect(
      screen.queryByTestId("setup-install-prereq"),
    ).not.toBeInTheDocument();
  });

  it("offers a 'Set up by agent' prompt copy once a real token exists", async () => {
    client.mintAccountToken = vi
      .fn()
      .mockResolvedValue({ token: "shp_realtoken123", id: "tok_1" });
    renderPanel({ stage: "connect", workspace: WS, agents: [] });

    // Pre-token the prompt would carry the placeholder and set up a broken
    // config — the button must not exist yet.
    expect(
      screen.queryByRole("button", { name: /set up by agent/i }),
    ).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: /generate token/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /set up by agent/i }),
    );

    const writes = vi.mocked(navigator.clipboard.writeText).mock.calls;
    const prompt = String(writes[writes.length - 1]?.[0]);
    expect(prompt).toContain("npm install -g @korso/shepherd");
    expect(prompt).toContain("shp_realtoken123");
    expect(prompt).toMatch(/restart/i);
  });

  it("copies the install command to the clipboard", async () => {
    renderPanel({ stage: "connect", workspace: WS, agents: [] });

    await userEvent.click(
      screen.getByRole("button", { name: /copy command/i }),
    );

    const cmd = screen.getByTestId("setup-install-command").textContent ?? "";
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(cmd);
  });

  it("surfaces a visible failure when the clipboard write is rejected", async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    renderPanel({ stage: "connect", workspace: WS, agents: [] });

    await userEvent.click(
      screen.getByRole("button", { name: /copy command/i }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/copy failed/i);
  });

  it("hides the feature cards until a token exists", () => {
    const { unmount } = renderPanel({ stage: "create" });
    expect(
      screen.queryByText(/works with any harness/i),
    ).not.toBeInTheDocument();
    unmount();

    // Connect stage, pre-mint, no agent yet: still hidden.
    renderPanel({ stage: "connect", workspace: WS, agents: [] });
    expect(
      screen.queryByText(/works with any harness/i),
    ).not.toBeInTheDocument();
  });

  it("shows the feature cards as a side rail once the token is generated", async () => {
    renderPanel({ stage: "connect", workspace: WS, agents: [] });

    await userEvent.click(
      screen.getByRole("button", { name: /generate token/i }),
    );

    const rail = await screen.findByRole("complementary", {
      name: /see what shepherd can do/i,
    });
    expect(rail).toHaveTextContent(/works with any harness/i);
    // First mint this view: the rail plays its staggered entrance, NOT the
    // whole-panel pop.
    expect(
      screen.getByRole("region", { name: /setup guide/i }),
    ).not.toHaveClass("shepherd-setup--pop");
  });

  it("keeps the rail across reopens after a mint and pops the panel as one", async () => {
    const first = renderPanel({ stage: "connect", workspace: WS, agents: [] });
    await userEvent.click(
      screen.getByRole("button", { name: /generate token/i }),
    );
    await screen.findByRole("complementary", {
      name: /see what shepherd can do/i,
    });
    first.unmount();

    // Reopened guide (fresh mount, no raw token, no agent yet): the persisted
    // milestone keeps the rail, and the panel enters as ONE animation.
    renderPanel({ stage: "connect", workspace: WS, agents: [] });
    expect(
      screen.getByRole("complementary", { name: /see what shepherd can do/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /setup guide/i })).toHaveClass(
      "shepherd-setup--pop",
    );
  });

  it("links the docs from the rail, opening in a new tab", async () => {
    renderPanel({ stage: "connect", workspace: WS, agents: [] });

    await userEvent.click(
      screen.getByRole("button", { name: /generate token/i }),
    );

    const docs = await screen.findByRole("link", { name: /read the docs/i });
    expect(docs).toHaveAttribute("href", "https://korsoai.com/docs");
    expect(docs).toHaveAttribute("target", "_blank");
    expect(docs).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
  });

  it("keeps the feature cards visible after the agent checks in (token scrubbed)", () => {
    renderPanel({ stage: "connect", workspace: WS, agents: [makeAgent()] });

    expect(screen.getByText(/works with any harness/i)).toBeInTheDocument();
  });

  it("shows the numbered next steps with agnostic wording and the closing line after minting", async () => {
    renderPanel({ stage: "connect", workspace: WS, agents: [] });

    await userEvent.click(
      screen.getByRole("button", { name: /generate token/i }),
    );

    expect(
      await screen.findByText(/run the commands above in your terminal/i),
    ).toBeInTheDocument();
    // Tool-agnostic: names "your coding agent", never a specific tool.
    expect(screen.getByText(/open your coding agent/i)).toBeInTheDocument();
    expect(screen.getByTestId("setup-link-message").textContent).toBe(
      "Link this repo to Shepherd",
    );
    expect(screen.getByText(/nothing else to do!/i)).toBeInTheDocument();
    expect(
      screen.getByText(/your agents will use this space to coordinate/i),
    ).toBeInTheDocument();
  });

  it("hides the next steps before a token is minted", () => {
    renderPanel({ stage: "connect", workspace: WS, agents: [] });

    expect(screen.queryByText(/nothing else to do/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("setup-link-message")).not.toBeInTheDocument();
  });

  it("swaps the run-it instruction for JSON-config tools", async () => {
    renderPanel({ stage: "connect", workspace: WS, agents: [] });

    await userEvent.click(
      screen.getByRole("button", { name: /generate token/i }),
    );
    await screen.findByText(/run the commands above in your terminal/i);

    await userEvent.selectOptions(screen.getByLabelText(/tool/i), "cursor");

    expect(screen.getByText(/\.cursor\/mcp\.json/)).toBeInTheDocument();
    expect(
      screen.queryByText(/run the commands above in your terminal/i),
    ).not.toBeInTheDocument();
  });

  it("copies the link message to the clipboard", async () => {
    renderPanel({ stage: "connect", workspace: WS, agents: [] });

    await userEvent.click(
      screen.getByRole("button", { name: /generate token/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /copy message/i }),
    );

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "Link this repo to Shepherd",
    );
  });

  it("calls onSkip once when Skip for now is clicked (connect stage)", async () => {
    const onSkip = vi.fn();
    renderPanel({ stage: "connect", workspace: WS, agents: [], onSkip });

    await userEvent.click(
      screen.getByRole("button", { name: /skip for now/i }),
    );
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("hides Skip for now in the create stage (a skip cannot dismiss the create step)", () => {
    renderPanel({ stage: "create" });

    expect(
      screen.queryByRole("button", { name: /skip for now/i }),
    ).not.toBeInTheDocument();
  });

  it("moves focus to step 2 when the stage advances from create to connect", async () => {
    const { rerender } = renderPanel({ stage: "create" });

    rerender(
      <ShepherdClientProvider client={client}>
        <SetupChecklist
          stage="connect"
          workspace={WS}
          agents={[]}
          hubUrl={HUB_URL}
          onWorkspacesChanged={vi.fn()}
          onSkip={vi.fn()}
        />
      </ShepherdClientProvider>,
    );

    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active?.textContent).toMatch(/connect your first agent/i);
    });
  });

  it("is a labelled setup section", () => {
    renderPanel();
    expect(
      screen.getByRole("region", { name: /setup guide/i }),
    ).toBeInTheDocument();
  });
});
