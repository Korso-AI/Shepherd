import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ShepherdClientProvider } from "../context.js";
import { ConnectAgent } from "./ConnectAgent.js";
import { makeMockClient } from "../test/mockClient.js";

// ---------------------------------------------------------------------------
// ConnectAgent — install-command render + token mint/revoke. DB-free: the mock
// ShepherdClient is injected via ShepherdClientProvider's `client` prop.
//
// Tokens minted here are ACCOUNT-scoped (mintAccountToken/listAccountTokens/
// revokeAccountToken), not workspace-scoped — the component no longer takes a
// workspaceId prop, since a single account-wide token works across every
// workspace the caller belongs to.
// ---------------------------------------------------------------------------

describe("ConnectAgent", () => {
  const HUB_URL = "https://hub.example.run.app";

  let client: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    client = makeMockClient({
      listAccountTokens: vi.fn().mockResolvedValue({ tokens: [] }),
    });
    // jsdom has no Clipboard implementation; stub it so the copy button works.
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  function renderConnect() {
    return render(
      <ShepherdClientProvider client={client}>
        <ConnectAgent hubUrl={HUB_URL} />
      </ShepherdClientProvider>,
    );
  }

  it("does not show a raw token until one is minted", async () => {
    renderConnect();
    await waitFor(() => expect(client.listAccountTokens).toHaveBeenCalled());
    // The command shows a placeholder, not a real shp_ token, before minting.
    const cmd = screen.getByTestId("install-command").textContent ?? "";
    expect(cmd).not.toMatch(/shp_realtoken/);
  });

  it("renders the install command with the direct Hub URL after minting a token", async () => {
    client.mintAccountToken = vi
      .fn()
      .mockResolvedValue({ token: "shp_realtoken123", id: "tok_1" });

    renderConnect();
    await waitFor(() => expect(client.listAccountTokens).toHaveBeenCalled());

    await userEvent.click(
      screen.getByRole("button", { name: /generate token/i }),
    );

    await waitFor(() => {
      const cmd = screen.getByTestId("install-command").textContent ?? "";
      expect(cmd).toContain("shp_realtoken123");
      expect(cmd).toContain(HUB_URL);
    });
    expect(client.mintAccountToken).toHaveBeenCalledWith(expect.any(Object));
  });

  it("surfaces the raw token exactly once (with a one-time notice)", async () => {
    client.mintAccountToken = vi
      .fn()
      .mockResolvedValue({ token: "shp_onceonly", id: "tok_1" });

    renderConnect();
    await userEvent.click(
      screen.getByRole("button", { name: /generate token/i }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("install-command").textContent).toContain(
        "shp_onceonly",
      );
    });
    // The one-time warning is shown so the operator knows to copy it now.
    expect(
      screen.getByText(/won't be shown again|shown once|only.*once/i),
    ).toBeInTheDocument();
  });

  it("switches the install command when a different tool is picked", async () => {
    client.mintAccountToken = vi
      .fn()
      .mockResolvedValue({ token: "shp_tok", id: "tok_1" });

    renderConnect();
    await userEvent.click(
      screen.getByRole("button", { name: /generate token/i }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("install-command").textContent).toContain(
        "shp_tok",
      ),
    );

    const claudeCmd = screen.getByTestId("install-command").textContent ?? "";
    expect(claudeCmd).toMatch(/claude mcp add/);
    // Two commands: global install first, then `mcp add` with only the bare
    // bin after `--` — the claude CLI mis-parses flags after the separator.
    expect(claudeCmd).toContain("npm install -g @korso/shepherd");
    expect(claudeCmd).toContain("-- shepherd-mcp");

    // Pick Codex — its CLI only accepts `--env`, and PROGRAM must be set
    // explicitly (it defaults to claude-code).
    await userEvent.selectOptions(screen.getByLabelText(/tool/i), "codex");
    await waitFor(() => {
      const codexCmd = screen.getByTestId("install-command").textContent ?? "";
      expect(codexCmd).toMatch(/codex mcp add/);
      expect(codexCmd).toContain("shp_tok");
      expect(codexCmd).toContain("--env HUB_URL=");
      expect(codexCmd).toContain("--env PROGRAM=codex");
      expect(codexCmd).not.toContain(" -e ");
    });

    // Pi and Cursor have no `mcp add` CLI — they get the JSON config block
    // (pointing at the installed bin) plus the npm install as its own box,
    // with PROGRAM identifying the tool in the presence feed.
    for (const tool of ["pi", "cursor"] as const) {
      await userEvent.selectOptions(screen.getByLabelText(/tool/i), tool);
      await waitFor(() => {
        const jsonCmd = screen.getByTestId("install-command").textContent ?? "";
        const parsed = JSON.parse(jsonCmd);
        expect(parsed.mcpServers.shepherd.env.PROGRAM).toBe(tool);
        expect(parsed.mcpServers.shepherd.env.SHEPHERD_TOKEN).toBe("shp_tok");
        expect(parsed.mcpServers.shepherd.command).toBe("shepherd-mcp");
      });
      expect(screen.getByTestId("install-prereq")).toHaveTextContent(
        "npm install -g @korso/shepherd",
      );
    }
  });

  it("offers a 'Set up by agent' prompt copy once a token is minted", async () => {
    client.mintAccountToken = vi
      .fn()
      .mockResolvedValue({ token: "shp_tok", id: "tok_1" });
    renderConnect();

    // No live token → no prompt button (it would embed the placeholder).
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
    expect(prompt).toContain("shp_tok");
    expect(prompt).toMatch(/restart/i);
  });

  it("copies the install command to the clipboard", async () => {
    renderConnect();
    await waitFor(() => expect(client.listAccountTokens).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: /copy/i }));

    const cmd = screen.getByTestId("install-command").textContent ?? "";
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(cmd);
    expect(
      await screen.findByRole("button", { name: /copied/i }),
    ).toBeInTheDocument();
  });

  it("lists existing tokens and revokes one", async () => {
    client.listAccountTokens = vi.fn().mockResolvedValue({
      tokens: [
        {
          id: "tok_old",
          name: "laptop",
          lastUsedAt: null,
          createdAt: "2026-06-01T00:00:00.000Z",
          revokedAt: null,
        },
      ],
    });
    client.revokeAccountToken = vi.fn().mockResolvedValue(undefined);

    renderConnect();
    await waitFor(() => expect(screen.getByText("laptop")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /revoke/i }));

    await waitFor(() =>
      expect(client.revokeAccountToken).toHaveBeenCalledWith("tok_old"),
    );
  });

  it("labels an unnamed token with a human fallback instead of the raw uuid", async () => {
    client.listAccountTokens = vi.fn().mockResolvedValue({
      tokens: [
        {
          id: "75e707e5-f39b-4e0b-9999-31dc9da94352",
          name: null,
          lastUsedAt: null,
          createdAt: "2026-06-01T00:00:00.000Z",
          revokedAt: null,
        },
      ],
    });

    renderConnect();

    // Fallback label + a short id suffix to tell unnamed twins apart — the
    // full uuid (which reads like a secret token) must never be the label.
    expect(
      await screen.findByText("Unnamed token (75e707e5)"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("75e707e5-f39b-4e0b-9999-31dc9da94352"),
    ).not.toBeInTheDocument();
  });

  it("shows a loading placeholder until the first token fetch resolves", async () => {
    let resolve!: (v: { tokens: [] }) => void;
    client.listAccountTokens = vi.fn().mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );

    renderConnect();

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    expect(screen.queryByText(/no tokens yet/i)).not.toBeInTheDocument();

    resolve({ tokens: [] });
    expect(await screen.findByText(/no tokens yet/i)).toBeInTheDocument();
  });

  it("gates the revoke button against double-submit", async () => {
    client.listAccountTokens = vi.fn().mockResolvedValue({
      tokens: [
        {
          id: "tok_old",
          name: "laptop",
          lastUsedAt: null,
          createdAt: "2026-06-01T00:00:00.000Z",
          revokedAt: null,
        },
      ],
    });
    let resolve!: () => void;
    client.revokeAccountToken = vi.fn().mockReturnValue(
      new Promise<void>((r) => {
        resolve = r;
      }),
    );

    renderConnect();
    const btn = await screen.findByRole("button", {
      name: /revoke token laptop/i,
    });
    await userEvent.click(btn);

    await waitFor(() => expect(btn).toBeDisabled());
    await userEvent.click(btn);
    expect(client.revokeAccountToken).toHaveBeenCalledTimes(1);

    resolve();
    await waitFor(() =>
      expect(client.revokeAccountToken).toHaveBeenCalledTimes(1),
    );
  });

  it("Claude Code: says hooks auto-install (with opt-out) and keeps the snippet as reference", async () => {
    renderConnect();
    await waitFor(() => expect(client.listAccountTokens).toHaveBeenCalled());

    // Default tool is Claude Code — the auto-install writes ~/.claude/settings.json.
    expect(screen.getByText(/sets itself up/i)).toBeInTheDocument();
    expect(screen.getByText(/settings\.json/)).toBeInTheDocument();
    expect(screen.getByText(/SHEPHERD_NO_AUTO_HOOKS=1/)).toBeInTheDocument();

    // The manual equivalent stays available as a collapsed reference.
    const snippet = screen.getByTestId("hook-snippet").textContent ?? "";
    const parsed = JSON.parse(snippet);
    const hookCmd = "npx -y --package=@korso/shepherd shepherd-inbox-hook";
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toBe(hookCmd);
    expect(parsed.hooks.PreToolUse[0].matcher).toBe("*");
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe(hookCmd);
  });

  it("Codex: auto-install note + TOML reference; Pi: auto note, no snippet; Cursor: auto + hooks.json", async () => {
    renderConnect();
    await waitFor(() => expect(client.listAccountTokens).toHaveBeenCalled());

    await userEvent.selectOptions(screen.getByLabelText(/tool/i), "codex");
    await waitFor(() => {
      const toml = screen.getByTestId("hook-snippet").textContent ?? "";
      expect(toml).toContain("[[hooks.UserPromptSubmit]]");
      expect(toml).toContain("[[hooks.SessionStart]]");
      expect(toml).toContain("[[hooks.PreToolUse]]");
      expect(toml).toContain('matcher = "*"');
      expect(toml).toContain("shepherd-inbox-hook");
    });
    expect(screen.getByText(/config\.toml/)).toBeInTheDocument();
    expect(screen.getByText(/sets itself up/i)).toBeInTheDocument();

    // Pi's delivery is a bundled extension FILE the auto-install copies in —
    // the note names it, but there is nothing to paste manually.
    await userEvent.selectOptions(screen.getByLabelText(/tool/i), "pi");
    await waitFor(() =>
      expect(screen.getByText(/shepherd-inbox\.js/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/sets itself up/i)).toBeInTheDocument();
    expect(screen.queryByTestId("hook-snippet")).not.toBeInTheDocument();

    // Cursor auto-installs into hooks.json — ONLY beforeSubmitPrompt, the one
    // event verified to inject the hook's output into model context.
    await userEvent.selectOptions(screen.getByLabelText(/tool/i), "cursor");
    await waitFor(() => {
      const json = screen.getByTestId("hook-snippet").textContent ?? "";
      const parsed = JSON.parse(json);
      expect(parsed.hooks.beforeSubmitPrompt[0].command).toContain(
        "shepherd-inbox-hook",
      );
      expect(Object.keys(parsed.hooks)).toEqual(["beforeSubmitPrompt"]);
    });
    expect(screen.getByText(/hooks\.json/)).toBeInTheDocument();
    expect(screen.getByText(/sets itself up/i)).toBeInTheDocument();

    // Generic makes no claims about the client at all.
    await userEvent.selectOptions(screen.getByLabelText(/tool/i), "generic");
    await waitFor(() =>
      expect(screen.queryByTestId("hook-snippet")).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/sets itself up/i)).not.toBeInTheDocument();
  });

  it("explains the token works across all workspaces and the first-run workspace ask", () => {
    renderConnect();
    expect(screen.getByText(/all your workspaces/i)).toBeInTheDocument();
    expect(screen.getByText(/which workspace/i)).toBeInTheDocument();
    // No hidden `shepherd link` step — the workspace choice is conversational.
    expect(screen.queryByText(/shepherd link/i)).not.toBeInTheDocument();
  });
});
