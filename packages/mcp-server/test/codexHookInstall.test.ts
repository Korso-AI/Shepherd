import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { autoInstallHooks, HOOK_COMMAND } from "../src/hookInstall.js";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "shepherd-codex-hooks-home-"));
}

function configFile(homeDir: string): string {
  return join(homeDir, ".codex", "config.toml");
}

function writeConfig(homeDir: string, source: string): void {
  mkdirSync(join(homeDir, ".codex"), { recursive: true });
  writeFileSync(configFile(homeDir), source, "utf8");
}

async function install(homeDir: string, hookScriptSource?: string) {
  return autoInstallHooks({
    clientName: "codex-mcp-client",
    homeDir,
    hookScriptSource,
    log: vi.fn(),
  });
}

function expectCanonicalHandlers(source: string, command: string): void {
  const marker = "# Added by Shepherd";
  const markerIndex = source.indexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  const canonical = source.slice(markerIndex);

  for (const event of ["UserPromptSubmit", "SessionStart", "PreToolUse"]) {
    expect(
      canonical.match(new RegExp(`^\\[\\[hooks\\.${event}\\]\\]$`, "gm")),
    ).toHaveLength(1);
    expect(
      canonical.match(
        new RegExp(`^\\[\\[hooks\\.${event}\\.hooks\\]\\]$`, "gm"),
      ),
    ).toHaveLength(1);
  }

  expect(canonical.match(/^type = "command"$/gm)).toHaveLength(3);
  expect(canonical.match(/^timeout = 20$/gm)).toHaveLength(3);
  expect(canonical.match(/^matcher = "\*"$/gm)).toHaveLength(1);
  expect(canonical.split(`command = ${JSON.stringify(command)}`)).toHaveLength(
    4,
  );
}

describe("Codex canonical hook installation", () => {
  it("creates a missing config with hooks enabled and all canonical handlers", async () => {
    const home = freshHome();

    const result = await install(home);

    expect(result.status).toBe("installed");
    const source = readFileSync(configFile(home), "utf8");
    expect(source).toContain("[features]\nhooks = true");
    expectCanonicalHandlers(source, HOOK_COMMAND);
  });

  it("appends only the canonical handlers when features.hooks is already true", async () => {
    const home = freshHome();
    const existing =
      '[features]\nhooks = true\nweb_search = true\n\n[projects."C:/work"]\ntrust_level = "trusted"\n';
    writeConfig(home, existing);

    const result = await install(home);

    expect(result.status).toBe("installed");
    const source = readFileSync(configFile(home), "utf8");
    expect(source.startsWith(existing)).toBe(true);
    expect(source.match(/^hooks = true$/gm)).toHaveLength(1);
    expectCanonicalHandlers(source, HOOK_COMMAND);
  });

  it("adds hooks=true inside an existing features table that lacks the key", async () => {
    const home = freshHome();
    writeConfig(
      home,
      '[features]\nweb_search = true\n\n[history]\npersistence = "save-all"\n',
    );

    const result = await install(home);

    expect(result.status).toBe("installed");
    const source = readFileSync(configFile(home), "utf8");
    expect(source).toMatch(/^\[features\]\nhooks = true\nweb_search = true$/m);
    expectCanonicalHandlers(source, HOOK_COMMAND);
  });

  it("ignores a features-like line inside a multiline string", async () => {
    const home = freshHome();
    const existing = [
      'notice = """',
      "[features]",
      '"""',
      "",
      "[features]",
      "web_search = true",
      "",
    ].join("\n");
    writeConfig(home, existing);

    const result = await install(home);

    expect(result.status).toBe("installed");
    const source = readFileSync(configFile(home), "utf8");
    const expectedPrefix = existing.replace(
      "\n[features]\nweb_search = true",
      "\n[features]\nhooks = true\nweb_search = true",
    );
    expect(source.startsWith(expectedPrefix)).toBe(true);
    expect(parse(source)["features"]).toMatchObject({ hooks: true });
    expectCanonicalHandlers(source, HOOK_COMMAND);
  });

  it("appends a features table and canonical handlers when features is absent", async () => {
    const home = freshHome();
    const existing =
      'model = "o4"\n\n[mcp_servers.shepherd]\ncommand = "npx"\n';
    writeConfig(home, existing);

    const result = await install(home);

    expect(result.status).toBe("installed");
    const source = readFileSync(configFile(home), "utf8");
    expect(source.startsWith(existing)).toBe(true);
    expect(source).toContain("[features]\nhooks = true");
    expectCanonicalHandlers(source, HOOK_COMMAND);
  });

  it.each(["false", '"yes"', "1"])(
    "leaves an explicit non-true hooks value (%s) untouched",
    async (value) => {
      const home = freshHome();
      const existing = `[features]\nhooks = ${value}\n`;
      writeConfig(home, existing);

      const result = await install(home);

      expect(result.status).toBe("skipped");
      expect(readFileSync(configFile(home), "utf8")).toBe(existing);
    },
  );

  it("byte-preserves unrelated hook groups while appending Shepherd handlers", async () => {
    const home = freshHome();
    const existing = [
      "[features]",
      "hooks = true",
      "",
      "[[hooks.Notification]]",
      'matcher = "agent-turn-complete"',
      "[[hooks.Notification.hooks]]",
      'type = "command"',
      'command = "notify-send done"',
      "timeout = 7",
      "",
    ].join("\r\n");
    writeConfig(home, existing);

    const result = await install(home);

    expect(result.status).toBe("installed");
    const source = readFileSync(configFile(home), "utf8");
    expect(source.slice(0, existing.length)).toBe(existing);
    expectCanonicalHandlers(source, HOOK_COMMAND);
  });

  it("uses a normalized cached Windows path as the command string", async () => {
    const home = freshHome();
    const sourceFile = join(home, "bundled-inboxHook.js");
    writeFileSync(sourceFile, "// bundled\n", "utf8");

    const result = await install(home, sourceFile);

    expect(result.status).toBe("installed");
    const cached = join(home, ".shepherd", "hooks", "shepherd-inbox-hook.mjs");
    expectCanonicalHandlers(
      readFileSync(configFile(home), "utf8"),
      `node "${cached.replace(/\\/g, "/")}"`,
    );
  });

  it("uses the version-pinned npx fallback as the command string", async () => {
    const home = freshHome();

    await install(home, join(home, "missing-inboxHook.js"));

    expect(HOOK_COMMAND).toMatch(/^npx -y --package=@korso\/shepherd@\d/);
    expectCanonicalHandlers(
      readFileSync(configFile(home), "utf8"),
      HOOK_COMMAND,
    );
  });

  it("leaves malformed TOML byte-identical", async () => {
    const home = freshHome();
    const malformed = '[features\nhooks = true\nmodel = "unterminated\n';
    writeConfig(home, malformed);

    const result = await install(home);

    expect(result.status).toBe("skipped");
    expect(readFileSync(configFile(home), "utf8")).toBe(malformed);
  });
});
