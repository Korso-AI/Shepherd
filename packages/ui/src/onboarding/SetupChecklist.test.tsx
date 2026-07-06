import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { WorkspaceAgentT, WorkspaceSummaryT } from "@shepherd/shared";
import { ShepherdClientProvider } from "../context.js";
import { SetupChecklist } from "./SetupChecklist.js";
import { makeMockClient } from "../test/mockClient.js";

// ---------------------------------------------------------------------------
// SetupChecklist — first-run three-step panel. DB-free: the mock ShepherdClient
// is injected via ShepherdClientProvider's `client` prop.
// ---------------------------------------------------------------------------

const WS: WorkspaceSummaryT = { id: "ws_1", slug: "acme", name: "Acme", role: "admin" };

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
    // jsdom has no Clipboard implementation; stub it so the copy button works.
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  function renderPanel(props: Partial<Parameters<typeof SetupChecklist>[0]> = {}) {
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

  it("creates a workspace with the trimmed name and notifies the caller", async () => {
    const onWorkspacesChanged = vi.fn();
    renderPanel({ onWorkspacesChanged });

    await userEvent.type(screen.getByLabelText(/workspace name/i), "  Acme  ");
    await userEvent.click(screen.getByRole("button", { name: /create workspace/i }));

    await waitFor(() =>
      expect(client.createWorkspace).toHaveBeenCalledWith({ name: "Acme" }),
    );
    expect(onWorkspacesChanged).toHaveBeenCalledTimes(1);
  });

  it("surfaces a create error and keeps the form", async () => {
    client.createWorkspace = vi.fn().mockRejectedValue(new Error("Name already taken"));
    renderPanel();

    await userEvent.type(screen.getByLabelText(/workspace name/i), "Acme");
    await userEvent.click(screen.getByRole("button", { name: /create workspace/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Name already taken");
    // Form still present for a retry.
    expect(screen.getByLabelText(/workspace name/i)).toBeInTheDocument();
  });

  it("connect stage: shows step 1 done and waits for an agent, then checks off when one appears", () => {
    const { rerender } = renderPanel({ stage: "connect", workspace: WS, agents: [] });

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

    expect(screen.queryByText(/waiting for your agent/i)).not.toBeInTheDocument();
    expect(screen.getByText(/wolf/)).toBeInTheDocument();
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

    await userEvent.click(screen.getByRole("button", { name: /generate token/i }));

    await waitFor(() => {
      const cmd = screen.getByTestId("setup-install-command").textContent ?? "";
      expect(cmd).toContain("shp_realtoken123");
      expect(cmd).toContain(HUB_URL);
    });
    expect(client.mintAccountToken).toHaveBeenCalledWith({ name: "Acme agent" });
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

  it("copies the install command to the clipboard", async () => {
    renderPanel({ stage: "connect", workspace: WS, agents: [] });

    await userEvent.click(screen.getByRole("button", { name: /copy command/i }));

    const cmd = screen.getByTestId("setup-install-command").textContent ?? "";
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(cmd);
  });

  it("renders the feature cards in both stages", () => {
    renderPanel({ stage: "create" });
    expect(screen.getByText(/works with any harness/i)).toBeInTheDocument();
  });

  it("calls onSkip once when Skip for now is clicked", async () => {
    const onSkip = vi.fn();
    renderPanel({ onSkip });

    await userEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("is a labelled setup section", () => {
    renderPanel();
    expect(screen.getByRole("region", { name: /setup guide/i })).toBeInTheDocument();
  });
});
