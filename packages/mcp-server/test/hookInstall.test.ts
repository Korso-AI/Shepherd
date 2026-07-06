import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectClient, autoInstallHooks } from "../src/hookInstall.js";

// Layer 4: on first run per machine+client, install the announcement-push hook
// into the client's own config — the way superpowers-style tools do — so
// passive delivery works with zero manual setup. Rules under test:
//   - ADDITIVE ONLY: never clobber or reorder a user's existing config;
//   - never touch a file we can't parse (skip + notice instead);
//   - one attempt per machine+client (the ~/.shepherd/hooks record);
//   - SHEPHERD_NO_AUTO_HOOKS opts out entirely;
//   - a manual install is detected and left alone.

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "shepherd-hooks-home-"));
}

function quiet() {
  return vi.fn();
}

describe("detectClient", () => {
  it("maps clientInfo names onto known clients", () => {
    expect(detectClient("claude-code")).toBe("claude");
    expect(detectClient("Claude Code")).toBe("claude");
    expect(detectClient("codex-mcp-client")).toBe("codex");
    expect(detectClient("cursor-vscode")).toBe("cursor");
    expect(detectClient("pi-mcp-adapter")).toBe("pi");
    expect(detectClient("pi")).toBe("pi");
  });

  it("never matches 'pi' inside another word, and unknowns stay unknown", () => {
    expect(detectClient("rapid-agent")).toBe("unknown");
    expect(detectClient("capybara")).toBe("unknown");
    expect(detectClient("some-editor")).toBe("unknown");
    expect(detectClient(undefined)).toBe("unknown");
    expect(detectClient("")).toBe("unknown");
  });
});

describe("autoInstallHooks — claude", () => {
  it("creates ~/.claude/settings.json with SessionStart + PreToolUse on a fresh machine", async () => {
    const home = freshHome();
    const result = await autoInstallHooks({ clientName: "claude-code", homeDir: home, log: quiet() });

    expect(result.status).toBe("installed");
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    const flat = JSON.stringify(settings);
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].matcher).toBe("*");
    expect(flat).toContain("shepherd-inbox-hook");
    // The attempt is recorded so it never re-runs.
    expect(existsSync(join(home, ".shepherd", "hooks", "claude.json"))).toBe(true);
  });

  it("merges ADDITIVELY into existing settings — nothing lost, nothing reordered away", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    const existing = {
      model: "opus",
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] }],
      },
    };
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(existing), "utf8");

    const result = await autoInstallHooks({ clientName: "claude-code", homeDir: home, log: quiet() });

    expect(result.status).toBe("installed");
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(settings.model).toBe("opus"); // untouched
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("my-linter"); // first, untouched
    expect(settings.hooks.PreToolUse).toHaveLength(2); // ours appended
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  it("NEVER touches an unparseable settings.json (skip + notice)", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{ definitely not json", "utf8");
    const log = quiet();

    const result = await autoInstallHooks({ clientName: "claude-code", homeDir: home, log });

    expect(result.status).toBe("skipped");
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe("{ definitely not json");
    expect(log).toHaveBeenCalled();
  });

  it("detects a manual install and leaves the file alone", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    const manual = JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "npx -y --package=@korso/shepherd shepherd-inbox-hook" }] },
        ],
      },
    });
    writeFileSync(join(home, ".claude", "settings.json"), manual, "utf8");

    const result = await autoInstallHooks({ clientName: "claude-code", homeDir: home, log: quiet() });

    expect(result.status).toBe("already-present");
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe(manual);
  });

  it("runs AT MOST once per machine+client: the record short-circuits later boots", async () => {
    const home = freshHome();
    await autoInstallHooks({ clientName: "claude-code", homeDir: home, log: quiet() });

    // Simulate the user deliberately removing the hook afterwards.
    writeFileSync(join(home, ".claude", "settings.json"), "{}", "utf8");

    const again = await autoInstallHooks({ clientName: "claude-code", homeDir: home, log: quiet() });
    expect(again.status).toBe("already-attempted");
    // Respect the user's removal: not reinstalled.
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe("{}");
  });
});

describe("autoInstallHooks — codex", () => {
  const home = () => freshHome();

  it("creates ~/.codex/config.toml with the feature flag and the hook on a fresh machine", async () => {
    const h = home();
    const result = await autoInstallHooks({ clientName: "codex-mcp-client", homeDir: h, log: quiet() });

    expect(result.status).toBe("installed");
    const toml = readFileSync(join(h, ".codex", "config.toml"), "utf8");
    expect(toml).toContain("[features]");
    expect(toml).toMatch(/^hooks = true$/m);
    expect(toml).toContain("[[hooks.UserPromptSubmit]]");
    expect(toml).toContain("shepherd-inbox-hook");
  });

  it("appends to an existing config without [features], preserving its content", async () => {
    const h = home();
    mkdirSync(join(h, ".codex"), { recursive: true });
    const existing = 'model = "o4"\n\n[mcp_servers.shepherd]\ncommand = "npx"\n';
    writeFileSync(join(h, ".codex", "config.toml"), existing, "utf8");

    const result = await autoInstallHooks({ clientName: "codex-mcp-client", homeDir: h, log: quiet() });

    expect(result.status).toBe("installed");
    const toml = readFileSync(join(h, ".codex", "config.toml"), "utf8");
    expect(toml.startsWith(existing)).toBe(true);
    expect(toml).toContain("[features]");
    expect(toml).toContain("[[hooks.UserPromptSubmit]]");
  });

  it("with [features] already having hooks = true, appends ONLY the hook block", async () => {
    const h = home();
    mkdirSync(join(h, ".codex"), { recursive: true });
    writeFileSync(join(h, ".codex", "config.toml"), "[features]\nhooks = true\n", "utf8");

    const result = await autoInstallHooks({ clientName: "codex-mcp-client", homeDir: h, log: quiet() });

    expect(result.status).toBe("installed");
    const toml = readFileSync(join(h, ".codex", "config.toml"), "utf8");
    expect(toml.match(/\[features\]/g)).toHaveLength(1); // no duplicate table
    expect(toml.match(/^hooks = true$/gm)).toHaveLength(1); // no duplicate key
    expect(toml).toContain("[[hooks.UserPromptSubmit]]");
  });

  it("with [features] but no hooks key, inserts hooks = true into that table", async () => {
    const h = home();
    mkdirSync(join(h, ".codex"), { recursive: true });
    writeFileSync(join(h, ".codex", "config.toml"), "[features]\nweb_search = true\n", "utf8");

    const result = await autoInstallHooks({ clientName: "codex-mcp-client", homeDir: h, log: quiet() });

    expect(result.status).toBe("installed");
    const toml = readFileSync(join(h, ".codex", "config.toml"), "utf8");
    expect(toml.match(/\[features\]/g)).toHaveLength(1);
    expect(toml).toMatch(/\[features\]\r?\nhooks = true/);
    expect(toml).toContain("web_search = true");
  });

  it("respects an explicit hooks = false (the user decided): skip, don't fight", async () => {
    const h = home();
    mkdirSync(join(h, ".codex"), { recursive: true });
    const existing = "[features]\nhooks = false\n";
    writeFileSync(join(h, ".codex", "config.toml"), existing, "utf8");
    const log = quiet();

    const result = await autoInstallHooks({ clientName: "codex-mcp-client", homeDir: h, log });

    expect(result.status).toBe("skipped");
    expect(readFileSync(join(h, ".codex", "config.toml"), "utf8")).toBe(existing);
  });

  it("skips when a non-array [hooks.UserPromptSubmit] table exists (append would corrupt)", async () => {
    const h = home();
    mkdirSync(join(h, ".codex"), { recursive: true });
    const existing = '[features]\nhooks = true\n\n[hooks.UserPromptSubmit]\ncommand = "mine"\n';
    writeFileSync(join(h, ".codex", "config.toml"), existing, "utf8");

    const result = await autoInstallHooks({ clientName: "codex-mcp-client", homeDir: h, log: quiet() });

    expect(result.status).toBe("skipped");
    expect(readFileSync(join(h, ".codex", "config.toml"), "utf8")).toBe(existing);
  });

  it("detects a manual install (command already present) and leaves the file alone", async () => {
    const h = home();
    mkdirSync(join(h, ".codex"), { recursive: true });
    const existing =
      '[features]\nhooks = true\n\n[[hooks.UserPromptSubmit]]\ncommand = ["npx", "-y", "--package=@korso/shepherd", "shepherd-inbox-hook"]\n';
    writeFileSync(join(h, ".codex", "config.toml"), existing, "utf8");

    const result = await autoInstallHooks({ clientName: "codex-mcp-client", homeDir: h, log: quiet() });

    expect(result.status).toBe("already-present");
    expect(readFileSync(join(h, ".codex", "config.toml"), "utf8")).toBe(existing);
  });
});

describe("autoInstallHooks — pi", () => {
  it("copies the bundled extension into ~/.pi/agent/extensions", async () => {
    const home = freshHome();
    const srcDir = mkdtempSync(join(tmpdir(), "shepherd-hooks-src-"));
    const source = join(srcDir, "inboxExtension.js");
    writeFileSync(source, "// shepherd pi extension bundle", "utf8");

    const result = await autoInstallHooks({
      clientName: "pi-mcp-adapter",
      homeDir: home,
      extensionSource: source,
      log: quiet(),
    });

    expect(result.status).toBe("installed");
    const dest = join(home, ".pi", "agent", "extensions", "shepherd-inbox.js");
    expect(readFileSync(dest, "utf8")).toBe("// shepherd pi extension bundle");
  });

  it("never overwrites an existing extension file", async () => {
    const home = freshHome();
    const dest = join(home, ".pi", "agent", "extensions", "shepherd-inbox.js");
    mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(dest, "// the user's own copy", "utf8");
    const srcDir = mkdtempSync(join(tmpdir(), "shepherd-hooks-src-"));
    const source = join(srcDir, "inboxExtension.js");
    writeFileSync(source, "// newer bundle", "utf8");

    const result = await autoInstallHooks({
      clientName: "pi",
      homeDir: home,
      extensionSource: source,
      log: quiet(),
    });

    expect(result.status).toBe("already-present");
    expect(readFileSync(dest, "utf8")).toBe("// the user's own copy");
  });

  it("skips gracefully when the bundled extension can't be found", async () => {
    const home = freshHome();
    const result = await autoInstallHooks({
      clientName: "pi",
      homeDir: home,
      extensionSource: join(home, "does-not-exist.js"),
      log: quiet(),
    });
    expect(result.status).toBe("skipped");
  });
});

describe("autoInstallHooks — gates", () => {
  it("SHEPHERD_NO_AUTO_HOOKS opts out entirely (nothing written, not even a record)", async () => {
    const home = freshHome();
    const result = await autoInstallHooks({
      clientName: "claude-code",
      homeDir: home,
      disabled: true,
      log: quiet(),
    });

    expect(result.status).toBe("disabled");
    expect(existsSync(join(home, ".claude"))).toBe(false);
    expect(existsSync(join(home, ".shepherd"))).toBe(false);
  });

  it("unknown clients get nothing", async () => {
    const home = freshHome();
    const result = await autoInstallHooks({ clientName: "mystery-ide", homeDir: home, log: quiet() });
    expect(result.status).toBe("unsupported");
    expect(existsSync(join(home, ".shepherd"))).toBe(false);
  });

  it("cursor: creates ~/.cursor/hooks.json with ONLY beforeSubmitPrompt (the verified event)", async () => {
    const home = freshHome();
    const result = await autoInstallHooks({ clientName: "cursor-vscode", homeDir: home, log: quiet() });

    expect(result.status).toBe("installed");
    const config = JSON.parse(readFileSync(join(home, ".cursor", "hooks.json"), "utf8"));
    expect(config.version).toBe(1);
    expect(config.hooks.beforeSubmitPrompt).toHaveLength(1);
    expect(config.hooks.beforeSubmitPrompt[0].command).toContain("shepherd-inbox-hook");
    // The drain CONSUMES announcements, so no unverified event may be wired.
    expect(Object.keys(config.hooks)).toEqual(["beforeSubmitPrompt"]);
    expect(existsSync(join(home, ".shepherd", "hooks", "cursor.json"))).toBe(true);
  });

  it("cursor: merges ADDITIVELY into an existing hooks.json", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const existing = {
      version: 1,
      hooks: {
        beforeShellExecution: [{ command: "my-guard" }],
        beforeSubmitPrompt: [{ command: "my-logger" }],
      },
    };
    writeFileSync(join(home, ".cursor", "hooks.json"), JSON.stringify(existing), "utf8");

    const result = await autoInstallHooks({ clientName: "cursor-vscode", homeDir: home, log: quiet() });

    expect(result.status).toBe("installed");
    const config = JSON.parse(readFileSync(join(home, ".cursor", "hooks.json"), "utf8"));
    expect(config.hooks.beforeShellExecution[0].command).toBe("my-guard"); // untouched
    expect(config.hooks.beforeSubmitPrompt[0].command).toBe("my-logger"); // first, untouched
    expect(config.hooks.beforeSubmitPrompt).toHaveLength(2); // ours appended
  });

  it("cursor: NEVER touches an unparseable hooks.json, and detects a manual install", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(join(home, ".cursor", "hooks.json"), "not json {", "utf8");
    const log = quiet();

    const skipped = await autoInstallHooks({ clientName: "cursor-vscode", homeDir: home, log });
    expect(skipped.status).toBe("skipped");
    expect(readFileSync(join(home, ".cursor", "hooks.json"), "utf8")).toBe("not json {");
    expect(log).toHaveBeenCalled();

    // A manual install (marker present) in a second home is left byte-identical.
    const home2 = freshHome();
    mkdirSync(join(home2, ".cursor"), { recursive: true });
    const manual = JSON.stringify({
      version: 1,
      hooks: {
        beforeSubmitPrompt: [
          { command: "npx -y --package=@korso/shepherd shepherd-inbox-hook" },
        ],
      },
    });
    writeFileSync(join(home2, ".cursor", "hooks.json"), manual, "utf8");
    const present = await autoInstallHooks({ clientName: "cursor-vscode", homeDir: home2, log: quiet() });
    expect(present.status).toBe("already-present");
    expect(readFileSync(join(home2, ".cursor", "hooks.json"), "utf8")).toBe(manual);
  });

  it("never throws, even when the home dir is unwritable garbage", async () => {
    const result = await autoInstallHooks({
      clientName: "claude-code",
      // A path that exists as a FILE, so every mkdir/write beneath it fails.
      homeDir: (() => {
        const dir = freshHome();
        const notADir = join(dir, "file");
        writeFileSync(notADir, "x", "utf8");
        return join(notADir, "nested");
      })(),
      log: quiet(),
    });
    expect(result.status).toBe("skipped");
  });
});
