import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorkspaceAgentT } from "@shepherd/shared";
import type { ShepherdClient } from "../../src/client.js";
import { ShepherdClientProvider } from "../../src/context.js";
import { Composer } from "../../src/components/Composer.js";

/** Builds a live agent with sensible defaults; per-case overrides narrow it. */
function agent(over: Partial<WorkspaceAgentT> = {}): WorkspaceAgentT {
  return {
    name: "RedDragon",
    human: "alice",
    program: "claude",
    model: "opus",
    repo: "korso",
    branch: "main",
    lastHeartbeatAt: "2026-06-28T12:00:00.000Z",
    presence: "live",
    ...over,
  };
}

/**
 * A client whose `announce`/`announceTo` are vi.fns the tests control.
 * `getLandscape` is present only to satisfy the interface — the Composer never
 * calls it. `announceTo` defaults to a noop ok so an unscoped test that never
 * supplies one still type-checks.
 */
function makeClient(
  announce: ShepherdClient["announce"],
  announceTo?: ShepherdClient["announceTo"],
): ShepherdClient {
  return {
    getLandscape: () => Promise.reject(new Error("not called")),
    announce,
    announceTo: announceTo ?? vi.fn().mockResolvedValue(OK),
  };
}

function renderComposer(opts: {
  agents: WorkspaceAgentT[];
  selectedRepo: string | null;
  announce: ShepherdClient["announce"];
  announceTo?: ShepherdClient["announceTo"];
  workspaceId?: string;
  onSent?: () => void | Promise<void>;
}) {
  const client = makeClient(opts.announce, opts.announceTo);
  return render(
    <ShepherdClientProvider client={client}>
      <Composer
        agents={opts.agents}
        selectedRepo={opts.selectedRepo}
        workspaceId={opts.workspaceId}
        onSent={opts.onSent ?? (() => {})}
      />
    </ShepherdClientProvider>,
  );
}

const OK = { ok: true as const, announcementIds: [1] };

describe("Composer", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("opens an autocomplete listing only live agents in the selected repo when typing '@Re'", async () => {
    const user = userEvent.setup();
    renderComposer({
      agents: [
        agent({ name: "RedDragon", presence: "live", repo: "korso" }),
        agent({ name: "RedFox", presence: "offline", repo: "korso" }),
        agent({ name: "ReefShark", presence: "live", repo: "other" }),
      ],
      selectedRepo: "korso",
      announce: vi.fn().mockResolvedValue(OK),
    });

    const input = screen.getByLabelText("Message the team");
    await user.click(input);
    await user.type(input, "@Re");

    const listbox = await screen.findByRole("listbox");
    const options = within(listbox).getAllByRole("option");
    const names = options.map((o) => o.textContent);
    // Only the live agent in repo "korso" whose name starts with "Re".
    expect(names.some((n) => n?.includes("RedDragon"))).toBe(true);
    expect(names.some((n) => n?.includes("RedFox"))).toBe(false);
    expect(names.some((n) => n?.includes("ReefShark"))).toBe(false);
  });

  it("accepting a suggestion inserts '@RedDragon '", async () => {
    const user = userEvent.setup();
    renderComposer({
      agents: [agent({ name: "RedDragon", presence: "live", repo: "korso" })],
      selectedRepo: "korso",
      announce: vi.fn().mockResolvedValue(OK),
    });

    const input = screen.getByLabelText("Message the team") as HTMLInputElement;
    await user.click(input);
    await user.type(input, "@Re");
    await screen.findByRole("listbox");
    await user.keyboard("{Enter}");

    expect(input.value).toBe("@RedDragon ");
  });

  it("opens the autocomplete for a mention at the very start of the input", async () => {
    const user = userEvent.setup();
    renderComposer({
      agents: [agent({ name: "RedDragon", presence: "live", repo: "korso" })],
      selectedRepo: "korso",
      announce: vi.fn().mockResolvedValue(OK),
    });

    const input = screen.getByLabelText("Message the team");
    await user.click(input);
    await user.type(input, "@R");

    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getAllByRole("option").length).toBeGreaterThan(0);
  });

  it("submitting '@RedDragon look' calls announce with the directed target and selected repo, then onSent", async () => {
    const user = userEvent.setup();
    const announce = vi.fn().mockResolvedValue(OK);
    const onSent = vi.fn();
    renderComposer({
      agents: [agent({ name: "RedDragon", presence: "live", repo: "korso" })],
      selectedRepo: "korso",
      announce,
      onSent,
    });

    const input = screen.getByLabelText("Message the team") as HTMLInputElement;
    await user.click(input);
    await user.type(input, "@RedDragon look");
    // Dismiss the autocomplete so Enter submits the form rather than accepting.
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(announce).toHaveBeenCalledTimes(1));
    expect(announce).toHaveBeenCalledWith({
      body: "@RedDragon look",
      targetAgentName: "RedDragon",
      repo: "korso",
    });
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    // Input clears on success.
    expect(input.value).toBe("");
  });

  it("sends via the plural announceTo(workspaceId, …) when workspaceId is supplied", async () => {
    const user = userEvent.setup();
    const announce = vi.fn().mockResolvedValue(OK);
    const announceTo = vi.fn().mockResolvedValue(OK);
    const onSent = vi.fn();
    renderComposer({
      agents: [agent({ name: "RedDragon", presence: "live", repo: "korso" })],
      selectedRepo: "korso",
      workspaceId: "ws1",
      announce,
      announceTo,
      onSent,
    });

    const input = screen.getByLabelText("Message the team") as HTMLInputElement;
    await user.click(input);
    await user.type(input, "@RedDragon look");
    // Dismiss the autocomplete so Enter/click submits rather than accepting.
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(announceTo).toHaveBeenCalledTimes(1));
    expect(announceTo).toHaveBeenCalledWith("ws1", {
      body: "@RedDragon look",
      targetAgentName: "RedDragon",
      repo: "korso",
    });
    // The singular alias is NOT used when scoped.
    expect(announce).not.toHaveBeenCalled();
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    expect(input.value).toBe("");
  });

  it("falls back to the singular announce(…) when no workspaceId is supplied", async () => {
    const user = userEvent.setup();
    const announce = vi.fn().mockResolvedValue(OK);
    const announceTo = vi.fn().mockResolvedValue(OK);
    renderComposer({
      agents: [agent({ name: "RedDragon", presence: "live", repo: "korso" })],
      selectedRepo: "korso",
      announce,
      announceTo,
    });

    const input = screen.getByLabelText("Message the team");
    await user.click(input);
    await user.type(input, "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(announce).toHaveBeenCalledTimes(1));
    // The plural route is NOT used in the self-host (unscoped) case.
    expect(announceTo).not.toHaveBeenCalled();
  });

  it("surfaces 'send failed' when a scoped announceTo rejects", async () => {
    const user = userEvent.setup();
    const announceTo = vi.fn().mockRejectedValue(new Error("HTTP 500"));
    renderComposer({
      agents: [agent()],
      selectedRepo: "korso",
      workspaceId: "ws1",
      announce: vi.fn().mockResolvedValue(OK),
      announceTo,
    });

    const input = screen.getByLabelText("Message the team") as HTMLInputElement;
    const sendBtn = screen.getByRole("button", { name: "Send" });
    await user.click(input);
    await user.type(input, "boom");
    await user.click(sendBtn);

    expect(await screen.findByText(/send failed/)).toBeInTheDocument();
    await waitFor(() => expect(sendBtn).not.toBeDisabled());
    expect(input.value).toBe("boom");
  });

  it("uses null repo when All repos is selected", async () => {
    const user = userEvent.setup();
    const announce = vi.fn().mockResolvedValue(OK);
    renderComposer({
      agents: [agent({ name: "RedDragon", presence: "live", repo: "korso" })],
      selectedRepo: "__all__",
      announce,
    });

    const input = screen.getByLabelText("Message the team");
    await user.click(input);
    await user.type(input, "hello all");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(announce).toHaveBeenCalledTimes(1));
    expect(announce).toHaveBeenCalledWith({
      body: "hello all",
      targetAgentName: null,
      repo: null,
    });
  });

  it("does NOT call announce for an empty/whitespace body", async () => {
    const user = userEvent.setup();
    const announce = vi.fn().mockResolvedValue(OK);
    renderComposer({
      agents: [agent()],
      selectedRepo: "korso",
      announce,
    });

    const input = screen.getByLabelText("Message the team");
    await user.click(input);
    await user.type(input, "   ");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(announce).not.toHaveBeenCalled();
  });

  it("shows 'send failed' and re-enables the button after a rejected announce", async () => {
    const user = userEvent.setup();
    const announce = vi.fn().mockRejectedValue(new Error("HTTP 500"));
    renderComposer({
      agents: [agent()],
      selectedRepo: "korso",
      announce,
    });

    const input = screen.getByLabelText("Message the team") as HTMLInputElement;
    const sendBtn = screen.getByRole("button", { name: "Send" });
    await user.click(input);
    await user.type(input, "boom");
    await user.click(sendBtn);

    expect(await screen.findByText(/send failed/)).toBeInTheDocument();
    await waitFor(() => expect(sendBtn).not.toBeDisabled());
    // The body is preserved so the operator can retry.
    expect(input.value).toBe("boom");
  });
});
