import { describe, it, expect } from "vitest";
import {
  TOOLS,
  TOKEN_PLACEHOLDER,
  installCommand,
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
    it("builds the Claude CLI command with the hub URL and token", () => {
      const cmd = installCommand("claude", "https://hub", "shp_x");
      expect(cmd).toContain("claude mcp add shepherd -s user");
      expect(cmd).toContain("HUB_URL=https://hub");
      expect(cmd).toContain("SHEPHERD_TOKEN=shp_x");
    });

    it("emits valid JSON for the generic tool with the env under mcpServers.shepherd", () => {
      const cmd = installCommand("generic", "https://hub", "shp_x");
      const parsed = JSON.parse(cmd);
      expect(parsed.mcpServers.shepherd.env.HUB_URL).toBe("https://hub");
      expect(parsed.mcpServers.shepherd.env.SHEPHERD_TOKEN).toBe("shp_x");
      // Generic makes no claim about the client, so no PROGRAM override.
      expect(parsed.mcpServers.shepherd.env.PROGRAM).toBeUndefined();
    });

    it("sets PROGRAM=codex on the Codex CLI command", () => {
      const cmd = installCommand("codex", "https://hub", "shp_x");
      expect(cmd).toContain("codex mcp add");
      expect(cmd).toContain("--env PROGRAM=codex");
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

  describe("parseTool", () => {
    it("accepts every pickable tool id", () => {
      for (const t of TOOLS) expect(parseTool(t.id)).toBe(t.id);
    });

    it("falls back to claude for anything unrecognized", () => {
      expect(parseTool("vim")).toBe("claude");
      expect(parseTool("")).toBe("claude");
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
