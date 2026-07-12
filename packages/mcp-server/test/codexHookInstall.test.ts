import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { autoInstallHooks, HOOK_COMMAND } from "../src/hookInstall.js";

const fsFaults = vi.hoisted(() => ({
  failRenameSuffix: null as string | null,
  replaceOnSecondConfigRead: null as string | null,
  configReads: 0,
  events: [] as string[],
  fileDescriptors: new Map<number, string>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const path = String(args[0]);
      if (path.endsWith("config.toml")) {
        fsFaults.configReads += 1;
        if (
          fsFaults.configReads === 2 &&
          fsFaults.replaceOnSecondConfigRead !== null
        ) {
          actual.writeFileSync(
            path,
            fsFaults.replaceOnSecondConfigRead,
            "utf8",
          );
        }
      }
      return actual.readFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (
        fsFaults.failRenameSuffix !== null &&
        String(args[1]).endsWith(fsFaults.failRenameSuffix)
      ) {
        throw new Error("injected rename failure");
      }
      fsFaults.events.push(`rename:${String(args[1])}`);
      return actual.renameSync(...args);
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      fsFaults.events.push("open:" + String(args[0]) + ":" + String(args[1]));
      const descriptor = actual.openSync(...args);
      fsFaults.fileDescriptors.set(descriptor, String(args[0]));
      return descriptor;
    },
    fsyncSync: (descriptor: number) => {
      fsFaults.events.push(
        `fsync:${fsFaults.fileDescriptors.get(descriptor) ?? "unknown"}`,
      );
      return actual.fsyncSync(descriptor);
    },
    closeSync: (descriptor: number) => {
      fsFaults.fileDescriptors.delete(descriptor);
      return actual.closeSync(descriptor);
    },
  };
});

beforeEach(() => {
  fsFaults.failRenameSuffix = null;
  fsFaults.replaceOnSecondConfigRead = null;
  fsFaults.configReads = 0;
  fsFaults.events.length = 0;
  fsFaults.fileDescriptors.clear();
});

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

function recordFile(homeDir: string): string {
  return join(homeDir, ".shepherd", "hooks", "codex.json");
}

function lockFile(homeDir: string): string {
  return join(homeDir, ".shepherd", "hooks", "codex-migration-v2.lock");
}

function backupFile(homeDir: string): string {
  return join(
    homeDir,
    ".shepherd",
    "hooks",
    "backups",
    "codex-config-before-v2.toml",
  );
}

function writeLegacyRecord(homeDir: string): void {
  mkdirSync(join(homeDir, ".shepherd", "hooks"), { recursive: true });
  writeFileSync(
    recordFile(homeDir),
    JSON.stringify({ status: "installed", at: "2026-07-03T00:00:00.000Z" }) +
      "\n",
    "utf8",
  );
}

function writeCurrentRecord(homeDir: string): string {
  mkdirSync(join(homeDir, ".shepherd", "hooks"), { recursive: true });
  const source =
    JSON.stringify({
      status: "installed",
      at: "2026-07-03T00:00:00.000Z",
      migrationVersion: 2,
      migrationOutcome: "already-canonical",
    }) + "\n";
  writeFileSync(recordFile(homeDir), source, "utf8");
  return source;
}

function readRecord(homeDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(recordFile(homeDir), "utf8"));
}

function legacyBlock(commandValue: string): string {
  return [
    "",
    "# Added by Shepherd: delivers teammate announcements to the agent. Remove to disable.",
    "[[hooks.UserPromptSubmit]]",
    `command = ${commandValue}`,
    "",
  ].join("\n");
}

function pinnedLegacyConfig(prefix = "[features]\nhooks = true\n"): string {
  const version = HOOK_COMMAND.match(/shepherd@([^ ]+)/)?.[1];
  const command =
    `["npx", "-y", "--package=@korso/shepherd@${version}", ` +
    '"shepherd-inbox-hook"]';
  return prefix + legacyBlock(command);
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

describe("Codex v2 migration state matrix", () => {
  it("records a fresh canonical install at migration version 2", async () => {
    const home = freshHome();
    const result = await install(home);

    expect(result.status).toBe("installed");
    expect(readRecord(home)).toMatchObject({
      status: "installed",
      migrationVersion: 2,
      migrationOutcome: "already-canonical",
    });
  });

  it("recognizes a complete canonical block without a record", async () => {
    const home = freshHome();
    await install(home);
    const canonical = readFileSync(configFile(home), "utf8");
    unlinkSync(recordFile(home));
    fsFaults.configReads = 0;

    const result = await install(home);

    expect(result.status).toBe("already-present");
    expect(readFileSync(configFile(home), "utf8")).toBe(canonical);
    expect(readRecord(home)["migrationOutcome"]).toBe("already-canonical");
  });

  it.each([
    ["exact legacy", pinnedLegacyConfig()],
    [
      "partial legacy",
      "[features]\nhooks = true\n\n# Added by Shepherd: delivers teammate announcements to the agent. Remove to disable.\n",
    ],
  ])(
    "leaves a %s manual install untouched when no legacy record proves ownership",
    async (_name, source) => {
      const home = freshHome();
      writeConfig(home, source);

      const result = await install(home);

      expect(["already-present", "skipped"]).toContain(result.status);
      expect(readFileSync(configFile(home), "utf8")).toBe(source);
      expect(readRecord(home)["migrationOutcome"]).toBe("ambiguous");
    },
  );

  it("migrates the exact released pinned-npx block owned by a legacy record", async () => {
    const home = freshHome();
    const prefix = 'model = "o4"\r\n\r\n[features]\r\nhooks = true\r\n';
    const source = pinnedLegacyConfig(prefix);
    writeConfig(home, source);
    writeLegacyRecord(home);

    const result = await install(home);

    expect(result.status).toBe("installed");
    const migrated = readFileSync(configFile(home), "utf8");
    expect(migrated.startsWith(prefix)).toBe(true);
    expectCanonicalHandlers(migrated, HOOK_COMMAND);
    expect(migrated).not.toContain('command = ["npx"');
    expect(readFileSync(backupFile(home), "utf8")).toBe(source);
    if (process.platform !== "win32") {
      expect(statSync(backupFile(home)).mode & 0o077).toBe(0);
    }
    expect(readRecord(home)).toMatchObject({
      status: "installed",
      at: "2026-07-03T00:00:00.000Z",
      migrationVersion: 2,
      migrationOutcome: "migrated",
    });
  });

  it("migrates the exact cached-node block only for this home", async () => {
    const home = freshHome();
    const bundle = join(home, "inboxHook.js");
    const cached = join(home, ".shepherd", "hooks", "shepherd-inbox-hook.mjs");
    writeFileSync(bundle, "// hook\n", "utf8");
    const source =
      "[features]\nhooks = true\n" +
      legacyBlock('["node", ' + JSON.stringify(cached) + "]");
    writeConfig(home, source);
    writeLegacyRecord(home);

    const result = await install(home, bundle);

    expect(result.status).toBe("installed");
    expectCanonicalHandlers(
      readFileSync(configFile(home), "utf8"),
      'node "' + cached.replace(/\\/g, "/") + '"',
    );
    expect(readRecord(home)["migrationOutcome"]).toBe("migrated");
  });

  it("recognizes the exact home-cached path even when no bundle is available", async () => {
    const home = freshHome();
    const cached = join(home, ".shepherd", "hooks", "shepherd-inbox-hook.mjs");
    mkdirSync(join(home, ".shepherd", "hooks"), { recursive: true });
    writeFileSync(cached, "// previously cached hook\n", "utf8");
    writeConfig(
      home,
      "[features]\nhooks = true\n" +
        legacyBlock('["node", ' + JSON.stringify(cached) + "]"),
    );
    writeLegacyRecord(home);

    const result = await install(home, join(home, "missing-bundle.js"));

    expect(result.status).toBe("installed");
    expect(readRecord(home)["migrationOutcome"]).toBe("migrated");
  });

  it.each([
    ["removed", "[features]\nhooks = true\n", "user-removed"],
    [
      "marker-only",
      "[features]\nhooks = true\n# Added by Shepherd: delivers teammate announcements to the agent. Remove to disable.\n",
      "ambiguous",
    ],
    [
      "modified",
      pinnedLegacyConfig().replace(
        'shepherd-inbox-hook"]',
        'shepherd-inbox-hook", "extra"]',
      ),
      "ambiguous",
    ],
  ])(
    "leaves a legacy record with a %s handler untouched",
    async (_name, source, outcome) => {
      const home = freshHome();
      writeConfig(home, source);
      writeLegacyRecord(home);

      const result = await install(home);

      expect(["already-present", "skipped"]).toContain(result.status);
      expect(readFileSync(configFile(home), "utf8")).toBe(source);
      expect(readRecord(home)["migrationOutcome"]).toBe(outcome);
      expect(existsSync(backupFile(home))).toBe(false);
    },
  );

  it("does not inspect or rewrite a current record", async () => {
    const home = freshHome();
    const config = "not valid toml";
    writeConfig(home, config);
    const record = writeCurrentRecord(home);

    const result = await install(home);

    expect(result.status).toBe("already-attempted");
    expect(readFileSync(configFile(home), "utf8")).toBe(config);
    expect(readFileSync(recordFile(home), "utf8")).toBe(record);
  });

  it.each([
    ["false", "opted-out"],
    ['"yes"', "unsupported-shape"],
    ["1", "unsupported-shape"],
  ])("records a conclusive hooks=%s skip", async (value, outcome) => {
    const home = freshHome();
    const source = "[features]\nhooks = " + value + "\n";
    writeConfig(home, source);

    const result = await install(home);

    expect(result.status).toBe("skipped");
    expect(readFileSync(configFile(home), "utf8")).toBe(source);
    expect(readRecord(home)["migrationOutcome"]).toBe(outcome);
  });

  it.each([
    ["malformed", '[features\nhooks = true\nmodel = "unterminated\n'],
    [
      "conflicting",
      '[features]\nhooks = true\n\n[hooks.UserPromptSubmit]\ncommand = "mine"\n',
    ],
  ])("records a conclusive %s TOML skip", async (_name, source) => {
    const home = freshHome();
    writeConfig(home, source);

    const result = await install(home);

    expect(result.status).toBe("skipped");
    expect(readFileSync(configFile(home), "utf8")).toBe(source);
    expect(readRecord(home)["migrationOutcome"]).toBe("unsupported-shape");
  });

  it("preserves a no-final-newline config byte-for-byte before its append", async () => {
    const home = freshHome();
    const source = 'model = "o4"';
    writeConfig(home, source);

    await install(home);

    expect(readFileSync(configFile(home), "utf8").startsWith(source)).toBe(
      true,
    );
  });

  it("leaves corrupt and future records untouched", async () => {
    const corruptHome = freshHome();
    writeConfig(corruptHome, "[features]\nhooks = true\n");
    mkdirSync(join(corruptHome, ".shepherd", "hooks"), { recursive: true });
    writeFileSync(recordFile(corruptHome), "{broken", "utf8");

    expect((await install(corruptHome)).status).toBe("skipped");
    expect(readFileSync(recordFile(corruptHome), "utf8")).toBe("{broken");

    const futureHome = freshHome();
    writeConfig(futureHome, "[features]\nhooks = true\n");
    mkdirSync(join(futureHome, ".shepherd", "hooks"), { recursive: true });
    const future = JSON.stringify({
      status: "installed",
      at: "2026-07-03T00:00:00.000Z",
      migrationVersion: 3,
      migrationOutcome: "migrated",
    });
    writeFileSync(recordFile(futureHome), future, "utf8");

    expect((await install(futureHome)).status).toBe("already-attempted");
    expect(readFileSync(recordFile(futureHome), "utf8")).toBe(future);
  });
});

describe("Codex v2 migration durability and concurrency", () => {
  it("recovers only a stale lock whose recorded PID is dead", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".shepherd", "hooks"), { recursive: true });
    writeFileSync(
      lockFile(home),
      JSON.stringify({
        pid: 2_147_483_647,
        createdAt: "2000-01-01T00:00:00.000Z",
      }),
      { mode: 0o600 },
    );

    expect((await install(home)).status).toBe("installed");
    expect(existsSync(lockFile(home))).toBe(false);
  });

  it.each([
    ["young dead", 2_147_483_647, new Date().toISOString()],
    ["old live", process.pid, "2000-01-01T00:00:00.000Z"],
  ])("does not recover a %s lock", async (_name, pid, createdAt) => {
    const home = freshHome();
    mkdirSync(join(home, ".shepherd", "hooks"), { recursive: true });
    const lock = JSON.stringify({ pid, createdAt });
    writeFileSync(lockFile(home), lock, { mode: 0o600 });

    expect((await install(home)).status).toBe("skipped");
    expect(readFileSync(lockFile(home), "utf8")).toBe(lock);
    expect(existsSync(recordFile(home))).toBe(false);
  });

  it("aborts when the exact-byte fingerprint changes after lock acquisition", async () => {
    const home = freshHome();
    const initial = "[features]\nhooks = true\n";
    const changed = "[features]\nhooks = true\n# concurrent user edit\n";
    writeConfig(home, initial);
    fsFaults.replaceOnSecondConfigRead = changed;

    const result = await install(home);

    expect(result.status).toBe("skipped");
    expect(readFileSync(configFile(home), "utf8")).toBe(changed);
    expect(existsSync(recordFile(home))).toBe(false);
    expect(existsSync(lockFile(home))).toBe(false);
  });

  it("writes and fsyncs config before advancing the record", async () => {
    const home = freshHome();
    const source = pinnedLegacyConfig();
    writeConfig(home, source);
    writeLegacyRecord(home);
    fsFaults.events.length = 0;

    await install(home);

    const configRename = fsFaults.events.findIndex(
      (event) => event === "rename:" + configFile(home),
    );
    const configFsync = fsFaults.events.findIndex(
      (event) => event === "fsync:" + configFile(home),
    );
    const recordRename = fsFaults.events.findIndex(
      (event) => event === "rename:" + recordFile(home),
    );
    expect(configRename).toBeGreaterThanOrEqual(0);
    expect(configFsync).toBeGreaterThan(configRename);
    expect(recordRename).toBeGreaterThan(configFsync);
  });

  it("rolls config back byte-identically when record replacement fails", async () => {
    const home = freshHome();
    const source = pinnedLegacyConfig();
    writeConfig(home, source);
    writeLegacyRecord(home);
    const legacyRecord = readFileSync(recordFile(home), "utf8");
    fsFaults.failRenameSuffix = "codex.json";

    const result = await install(home);

    expect(result.status).toBe("skipped");
    expect(readFileSync(configFile(home), "utf8")).toBe(source);
    expect(readFileSync(recordFile(home), "utf8")).toBe(legacyRecord);
    expect(existsSync(lockFile(home))).toBe(false);
  });

  it("keeps one exclusive byte-identical backup and permits an exact retry", async () => {
    const home = freshHome();
    const source = pinnedLegacyConfig();
    writeConfig(home, source);
    writeLegacyRecord(home);
    mkdirSync(join(home, ".shepherd", "hooks", "backups"), {
      recursive: true,
    });
    writeFileSync(backupFile(home), source, { mode: 0o666 });
    chmodSync(backupFile(home), 0o600);

    expect((await install(home)).status).toBe("installed");
    expect(readFileSync(backupFile(home), "utf8")).toBe(source);
    if (process.platform !== "win32") {
      expect(statSync(backupFile(home)).mode & 0o077).toBe(0);
    }
  });

  it("aborts on a mismatched persistent backup without advancing the record", async () => {
    const home = freshHome();
    const source = pinnedLegacyConfig();
    writeConfig(home, source);
    writeLegacyRecord(home);
    const record = readFileSync(recordFile(home), "utf8");
    mkdirSync(join(home, ".shepherd", "hooks", "backups"), {
      recursive: true,
    });
    writeFileSync(backupFile(home), "different config", { mode: 0o600 });

    expect((await install(home)).status).toBe("skipped");
    expect(readFileSync(configFile(home), "utf8")).toBe(source);
    expect(readFileSync(recordFile(home), "utf8")).toBe(record);
    expect(existsSync(lockFile(home))).toBe(false);
  });

  it("is idempotent on the second boot", async () => {
    const home = freshHome();
    writeConfig(home, pinnedLegacyConfig());
    writeLegacyRecord(home);
    await install(home);
    const config = readFileSync(configFile(home), "utf8");
    const backup = readFileSync(backupFile(home), "utf8");
    const record = readFileSync(recordFile(home), "utf8");

    const second = await install(home);

    expect(second.status).toBe("already-attempted");
    expect(readFileSync(configFile(home), "utf8")).toBe(config);
    expect(readFileSync(backupFile(home), "utf8")).toBe(backup);
    expect(readFileSync(recordFile(home), "utf8")).toBe(record);
  });

  it("serializes two public installers so they cannot append twice", async () => {
    const home = freshHome();

    const results = await Promise.all([install(home), install(home)]);

    expect(results.filter(({ status }) => status === "installed")).toHaveLength(
      1,
    );
    const source = readFileSync(configFile(home), "utf8");
    expect(source.match(/# Added by Shepherd/g)).toHaveLength(1);
    expect(
      fsFaults.events.some(
        (event) => event === "open:" + lockFile(home) + ":wx",
      ),
    ).toBe(true);
    expect(existsSync(lockFile(home))).toBe(false);
  });

  it("does not advance the legacy record when backup creation fails", async () => {
    const home = freshHome();
    const source = pinnedLegacyConfig();
    writeConfig(home, source);
    writeLegacyRecord(home);
    const record = readFileSync(recordFile(home), "utf8");
    mkdirSync(backupFile(home), { recursive: true });

    expect((await install(home)).status).toBe("skipped");
    expect(readFileSync(configFile(home), "utf8")).toBe(source);
    expect(readFileSync(recordFile(home), "utf8")).toBe(record);
    expect(existsSync(lockFile(home))).toBe(false);
  });

  it("does not migrate or advance a record while auto hooks are disabled", async () => {
    const home = freshHome();
    const source = pinnedLegacyConfig();
    writeConfig(home, source);
    writeLegacyRecord(home);
    const record = readFileSync(recordFile(home), "utf8");

    const result = await autoInstallHooks({
      clientName: "codex",
      homeDir: home,
      disabled: true,
      log: vi.fn(),
    });

    expect(result.status).toBe("disabled");
    expect(readFileSync(configFile(home), "utf8")).toBe(source);
    expect(readFileSync(recordFile(home), "utf8")).toBe(record);
    expect(existsSync(lockFile(home))).toBe(false);
  });
});
