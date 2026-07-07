import { describe, it, expect } from "vitest";
import {
  TOOLS,
  TOKEN_PLACEHOLDER,
  agentSetupPrompt,
  installCommand,
  installInstruction,
  installPrerequisite,
  hookSetup,
  parseTool,
} from "./connectCommand.js";

// ---------------------------------------------------------------------------
// connectCommand — pure install-command / hook-setup logic shared by the
// dashboard's ConnectAgent and the checklist so the two cannot drift.
// ---------------------------------------------------------------------------

describe("connectCommand", () => {
  it("exposes the five tools and a placeholder token", () => {
    expect(TOOLS.map((t) => t.id)).toEqual([
      "claude",
      "codex",
      "pi",
      "cursor",
      "generic",
    ]);
    expect(TOKEN_PLACEHOLDER).toMatch(/^shp_/);
  });

  describe("installCommand", () => {
    it("builds the Claude CLI setup as two commands: global install, then mcp add", () => {
      const cmd = installCommand("claude", "https://hub", "shp_x");
      const lines = cmd.split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe("npm install -g @korso/shepherd");
      expect(lines[1]).toContain("claude mcp add shepherd -s user");
      expect(lines[1]).toContain("HUB_URL=https://hub");
      expect(lines[1]).toContain("SHEPHERD_TOKEN=shp_x");
      // Only the bare installed bin may follow `--`: the claude CLI mis-parses
      // flags after the separator, so no `npx -y --package=…` there.
      expect(lines[1]).toMatch(/-- shepherd-mcp$/);
      expect(cmd).not.toContain("npx");
    });

    it("emits valid JSON for the generic tool with the env under mcpServers.shepherd", () => {
      const cmd = installCommand("generic", "https://hub", "shp_x");
      const parsed = JSON.parse(cmd);
      expect(parsed.mcpServers.shepherd.env.HUB_URL).toBe("https://hub");
      expect(parsed.mcpServers.shepherd.env.SHEPHERD_TOKEN).toBe("shp_x");
      // Generic makes no claim about the client, so no PROGRAM override.
      expect(parsed.mcpServers.shepherd.env.PROGRAM).toBeUndefined();
      // Points at the globally-installed bin (the separate npm-install
      // prerequisite), not an inline npx invocation.
      expect(parsed.mcpServers.shepherd.command).toBe("shepherd-mcp");
      expect(parsed.mcpServers.shepherd.args).toEqual([]);
    });

    it("sets PROGRAM=codex on the Codex CLI command (same two-command shape)", () => {
      const cmd = installCommand("codex", "https://hub", "shp_x");
      const lines = cmd.split("\n");
      expect(lines[0]).toBe("npm install -g @korso/shepherd");
      expect(lines[1]).toContain("codex mcp add");
      expect(lines[1]).toContain("--env PROGRAM=codex");
      expect(lines[1]).toMatch(/-- shepherd-mcp$/);
    });

    it("never emits a hub URL with shell metacharacters into the command", () => {
      // A misconfigured/hostile hubUrl must not paste `$(…)`, `;` etc. into
      // the operator's terminal — it degrades to a fill-in placeholder.
      for (const bad of [
        "https://hub; rm -rf ~",
        "https://hub/$(curl evil)",
        "not a url",
        "javascript:alert(1)",
      ]) {
        const cmd = installCommand("claude", bad, "shp_x");
        expect(cmd).toContain("HUB_URL=<your-hub-url>");
        expect(cmd).not.toContain(";");
        expect(cmd).not.toContain("$(");
      }
    });

    it("never emits a token that doesn't look like a minted shp_ token", () => {
      const cmd = installCommand("claude", "https://hub", "shp_x; echo pwned");
      expect(cmd).toContain(`SHEPHERD_TOKEN=${TOKEN_PLACEHOLDER}`);
      expect(cmd).not.toContain("pwned");
    });
  });

  describe("installPrerequisite", () => {
    it("gives JSON-config tools the npm install as a separate command", () => {
      for (const tool of ["pi", "cursor", "generic"] as const) {
        expect(installPrerequisite(tool)).toBe(
          "npm install -g @korso/shepherd",
        );
      }
    });

    it("is null for CLI tools, whose command string already embeds the install", () => {
      expect(installPrerequisite("claude")).toBeNull();
      expect(installPrerequisite("codex")).toBeNull();
      expect(installCommand("claude", "https://hub", "shp_x")).toContain(
        "npm install -g @korso/shepherd",
      );
    });
  });

  describe("agentSetupPrompt", () => {
    it("wraps the CLI commands in a paste-into-your-agent prompt", () => {
      const p = agentSetupPrompt("claude", "https://hub", "shp_x");
      expect(p).toContain("npm install -g @korso/shepherd");
      expect(p).toContain("claude mcp add shepherd -s user");
      expect(p).toContain("SHEPHERD_TOKEN=shp_x");
      // The agent must hand back control for the reload + link steps.
      expect(p).toMatch(/restart/i);
      expect(p).toMatch(/link this repo/i);
    });

    it("tells JSON-config tools where to merge the block without clobbering it", () => {
      const p = agentSetupPrompt("pi", "https://hub", "shp_x");
      expect(p).toContain("npm install -g @korso/shepherd");
      expect(p).toContain("~/.pi/agent/mcp.json");
      expect(p).toMatch(/merge/i);
      expect(p).toContain('"shepherd-mcp"');
      expect(p).toContain('"SHEPHERD_TOKEN": "shp_x"');
    });

    it("inherits the shell-safety placeholders for hostile values", () => {
      const p = agentSetupPrompt(
        "claude",
        "https://hub/$(curl evil)",
        "shp_x; echo pwned",
      );
      expect(p).not.toContain("$(");
      expect(p).not.toContain("pwned");
      expect(p).toContain(TOKEN_PLACEHOLDER);
    });
  });

  describe("parseTool", () => {
    it("accepts every pickable tool id", () => {
      for (const t of TOOLS) expect(parseTool(t.id)).toBe(t.id);
    });

    it("falls back to claude for anything unrecognized", () => {
      expect(parseTool("vim")).toBe("claude");
      expect(parseTool("")).toBe("claude");
    });
  });

  describe("installInstruction", () => {
    it("tells CLI tools to run the commands in a terminal", () => {
      expect(installInstruction("claude")).toMatch(
        /run the commands above in your terminal/i,
      );
      expect(installInstruction("codex")).toMatch(
        /run the commands above in your terminal/i,
      );
    });

    it("tells JSON-config tools to run the install, then save to their MCP config file", () => {
      for (const tool of ["pi", "cursor", "generic"] as const) {
        expect(installInstruction(tool)).toMatch(/run the install command/i);
      }
      expect(installInstruction("pi")).toContain("~/.pi/agent/mcp.json");
      expect(installInstruction("cursor")).toContain("~/.cursor/mcp.json");
      expect(installInstruction("generic")).toMatch(/mcp/i);
    });
  });

  describe("hookSetup", () => {
    it("returns null for the generic tool", () => {
      expect(hookSetup("generic")).toBeNull();
    });

    it("gives Pi a bundled-file target with no snippet to paste", () => {
      const hook = hookSetup("pi");
      expect(hook).not.toBeNull();
      expect(hook?.snippet).toBeNull();
      expect(hook?.target).toContain("~/.pi/");
    });
  });
});
