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
import { autoInstallHooks, HOOK_COMMAND } from "../src/hookInstall.js";

const faults = vi.hoisted(() => ({
  configReads: 0,
  replaceOnSecondRead: null as string | null,
  replaceOnBackupOpen: null as string | null,
  failRenameSuffix: null as string | null,
  failFsyncOnceSuffix: null as string | null,
  events: [] as string[],
  descriptors: new Map<number, string>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      const path = String(args[0]);
      if (path.endsWith("config.toml")) {
        faults.configReads += 1;
        if (faults.configReads === 2 && faults.replaceOnSecondRead !== null) {
          fs.writeFileSync(path, faults.replaceOnSecondRead, "utf8");
        }
      }
      return fs.readFileSync(...args);
    },
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const path = String(args[0]);
      faults.events.push("open:" + path + ":" + String(args[1]));
      if (
        path.includes("codex-config-before-v2.toml.") &&
        path.endsWith(".tmp") &&
        args[1] === "wx" &&
        faults.replaceOnBackupOpen !== null
      ) {
        const home = path.slice(0, path.indexOf(join(".shepherd", "hooks")));
        fs.writeFileSync(
          join(home, ".codex", "config.toml"),
          faults.replaceOnBackupOpen,
          "utf8",
        );
      }
      const descriptor = fs.openSync(...args);
      faults.descriptors.set(descriptor, path);
      return descriptor;
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      const target = String(args[1]);
      if (
        faults.failRenameSuffix !== null &&
        target.endsWith(faults.failRenameSuffix)
      ) {
        throw new Error("injected rename failure");
      }
      faults.events.push("rename:" + target);
      return fs.renameSync(...args);
    },
    fsyncSync: (descriptor: number) => {
      const path = faults.descriptors.get(descriptor) ?? "";
      faults.events.push("fsync:" + path);
      if (
        faults.failFsyncOnceSuffix !== null &&
        path.includes(faults.failFsyncOnceSuffix)
      ) {
        faults.failFsyncOnceSuffix = null;
        throw new Error("injected fsync failure");
      }
      return fs.fsyncSync(descriptor);
    },
    closeSync: (descriptor: number) => {
      faults.descriptors.delete(descriptor);
      return fs.closeSync(descriptor);
    },
  };
});

beforeEach(() => {
  faults.configReads = 0;
  faults.replaceOnSecondRead = null;
  faults.replaceOnBackupOpen = null;
  faults.failRenameSuffix = null;
  faults.failFsyncOnceSuffix = null;
  faults.events.length = 0;
  faults.descriptors.clear();
});

const COMMENT =
  "# Added by Shepherd: delivers teammate announcements to the agent. Remove to disable.";

function home(): string {
  return mkdtempSync(join(tmpdir(), "shepherd-codex-migration-"));
}
function configFile(root: string): string {
  return join(root, ".codex", "config.toml");
}
function recordFile(root: string): string {
  return join(root, ".shepherd", "hooks", "codex.json");
}
function lockFile(root: string): string {
  return join(root, ".shepherd", "hooks", "codex-migration-v2.lock");
}
function backupFile(root: string): string {
  return join(
    root,
    ".shepherd",
    "hooks",
    "backups",
    "codex-config-before-v2.toml",
  );
}
function writeConfig(root: string, source: string): void {
  mkdirSync(join(root, ".codex"), { recursive: true });
  writeFileSync(configFile(root), source, "utf8");
}
function legacyBlock(version = "0.11.1"): string {
  return [
    "",
    COMMENT,
    "[[hooks.UserPromptSubmit]]",
    'command = ["npx", "-y", "--package=@korso/shepherd@' +
      version +
      '", "shepherd-inbox-hook"]',
    "",
  ].join("\n");
}
function legacyConfig(version = "0.11.1"): string {
  return "[features]\nhooks = true\n" + legacyBlock(version);
}
function writeLegacyRecord(root: string): string {
  mkdirSync(join(root, ".shepherd", "hooks"), { recursive: true });
  const record =
    JSON.stringify({ status: "installed", at: "2026-07-03T00:00:00.000Z" }) +
    "\n";
  writeFileSync(recordFile(root), record, "utf8");
  return record;
}
function readRecord(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(recordFile(root), "utf8"));
}
function eventBlock(event: "SessionStart" | "PreToolUse"): string {
  return [
    "[[hooks." + event + "]]",
    ...(event === "PreToolUse" ? ['matcher = "*"'] : []),
    "[[hooks." + event + ".hooks]]",
    'type = "command"',
    "command = " + JSON.stringify(HOOK_COMMAND),
    "timeout = 20",
    "",
  ].join("\n");
}
async function install(
  root: string,
  log = vi.fn<(message: string) => void>(),
  disabled = false,
) {
  return {
    result: await autoInstallHooks({
      clientName: "codex",
      homeDir: root,
      hookScriptSource: join(root, "missing-hook.js"),
      disabled,
      log,
    }),
    log,
  };
}
function setupLegacy(root: string, source = legacyConfig()): string {
  writeConfig(root, source);
  writeLegacyRecord(root);
  return source;
}

describe("Codex v2 migration ownership and shape", () => {
  it("records fresh and already-canonical installs at migration version 2", async () => {
    const root = home();
    expect((await install(root)).result.status).toBe("installed");
    expect(readRecord(root)).toMatchObject({
      migrationVersion: 2,
      migrationOutcome: "already-canonical",
    });
    const source = readFileSync(configFile(root), "utf8");
    unlinkSync(recordFile(root));
    faults.configReads = 0;

    expect((await install(root)).result.status).toBe("already-present");
    expect(readFileSync(configFile(root), "utf8")).toBe(source);
  });

  it("migrates a strictly semver-pinned hook from an older release", async () => {
    const root = home();
    const source = setupLegacy(root, legacyConfig("0.10.7"));

    expect((await install(root)).result.status).toBe("installed");
    const migrated = readFileSync(configFile(root), "utf8");
    expect(migrated.startsWith(source)).toBe(true);
    expect(readRecord(root)["migrationOutcome"]).toBe("migrated");
  });

  it.each(["latest", "^0.11.1", "0.11"])(
    "does not claim an unpinned version %s",
    async (version) => {
      const root = home();
      const source = setupLegacy(root, legacyConfig(version));
      expect((await install(root)).result.status).toBe("already-present");
      expect(readFileSync(configFile(root), "utf8")).toBe(source);
      expect(readRecord(root)["migrationOutcome"]).toBe("ambiguous");
    },
  );

  it("retains the legacy prompt handler byte-identically and appends missing handlers", async () => {
    const root = home();
    const source = setupLegacy(root);

    await install(root);

    const migrated = readFileSync(configFile(root), "utf8");
    expect(migrated.slice(0, source.length)).toBe(source);
    expect(migrated.match(/^\[\[hooks\.UserPromptSubmit\]\]$/gm)).toHaveLength(
      1,
    );
    expect(migrated.match(/^\[\[hooks\.SessionStart\]\]$/gm)).toHaveLength(1);
    expect(migrated.match(/^\[\[hooks\.PreToolUse\]\]$/gm)).toHaveLength(1);
  });

  it("migrates only the exact cached-node path under this home", async () => {
    const root = home();
    const cached = join(root, ".shepherd", "hooks", "shepherd-inbox-hook.mjs");
    const source =
      "[features]\nhooks = true\n" +
      [
        "",
        COMMENT,
        "[[hooks.UserPromptSubmit]]",
        'command = ["node", ' + JSON.stringify(cached) + "]",
        "",
      ].join("\n");
    setupLegacy(root, source);

    expect((await install(root)).result.status).toBe("installed");
    expect(readFileSync(configFile(root), "utf8").startsWith(source)).toBe(
      true,
    );
  });

  it.each(["SessionStart", "PreToolUse"] as const)(
    "does not duplicate an existing canonical %s handler",
    async (event) => {
      const root = home();
      const source = setupLegacy(root, legacyConfig() + eventBlock(event));

      await install(root);

      const migrated = readFileSync(configFile(root), "utf8");
      expect(migrated.slice(0, source.length)).toBe(source);
      expect(
        migrated.match(new RegExp("^\\[\\[hooks\\." + event + "\\]\\]$", "gm")),
      ).toHaveLength(1);
    },
  );

  it.each([
    ["no record exact legacy", legacyConfig(), "ambiguous"],
    ["removed", "[features]\nhooks = true\n", "user-removed"],
    ["marker only", "[features]\nhooks = true\n" + COMMENT + "\n", "ambiguous"],
    [
      "modified",
      legacyConfig().replace('"shepherd-inbox-hook"]', '"other"]'),
      "ambiguous",
    ],
  ])("leaves %s untouched", async (name, source, outcome) => {
    const root = home();
    writeConfig(root, source);
    if (name !== "no record exact legacy") writeLegacyRecord(root);

    await install(root);

    expect(readFileSync(configFile(root), "utf8")).toBe(source);
    expect(readRecord(root)["migrationOutcome"]).toBe(outcome);
  });

  it.each([
    ["false", "opted-out"],
    ['"yes"', "unsupported-shape"],
    ["1", "unsupported-shape"],
  ])("records a conclusive hooks=%s skip", async (value, outcome) => {
    const root = home();
    writeConfig(root, "[features]\nhooks = " + value + "\n");
    expect((await install(root)).result.status).toBe("skipped");
    expect(readRecord(root)["migrationOutcome"]).toBe(outcome);
  });

  it.each([
    ["malformed", "[features\nhooks = true\n"],
    [
      "conflicting",
      '[features]\nhooks = true\n[hooks.UserPromptSubmit]\ncommand = "mine"\n',
    ],
  ])("records a conclusive %s config skip", async (_name, source) => {
    const root = home();
    writeConfig(root, source);
    await install(root);
    expect(readFileSync(configFile(root), "utf8")).toBe(source);
    expect(readRecord(root)["migrationOutcome"]).toBe("unsupported-shape");
  });

  it("leaves corrupt, current, and future records untouched", async () => {
    for (const record of [
      "{broken",
      JSON.stringify({
        status: "installed",
        at: "now",
        migrationVersion: 2,
        migrationOutcome: "migrated",
      }),
      JSON.stringify({
        status: "installed",
        at: "now",
        migrationVersion: 3,
        migrationOutcome: "migrated",
      }),
    ]) {
      const root = home();
      writeConfig(root, "[features]\nhooks = true\n");
      mkdirSync(join(root, ".shepherd", "hooks"), { recursive: true });
      writeFileSync(recordFile(root), record, "utf8");
      await install(root);
      expect(readFileSync(recordFile(root), "utf8")).toBe(record);
    }
  });
});

describe("Codex v2 migration durability", () => {
  it("rechecks the fingerprint after creating the backup", async () => {
    const root = home();
    const source = setupLegacy(root);
    const changed = source + "# concurrent edit\n";
    faults.replaceOnBackupOpen = changed;

    expect((await install(root)).result.status).toBe("skipped");
    expect(readFileSync(configFile(root), "utf8")).toBe(changed);
    expect(readRecord(root)["migrationVersion"]).toBeUndefined();
  });

  it("rolls back config and record when record durability fails", async () => {
    const root = home();
    const source = setupLegacy(root);
    const record = readFileSync(recordFile(root), "utf8");
    faults.failFsyncOnceSuffix = ".codex.json.";

    expect((await install(root)).result.status).toBe("skipped");
    expect(readFileSync(configFile(root), "utf8")).toBe(source);
    expect(readFileSync(recordFile(root), "utf8")).toBe(record);
  });

  it("preserves config mode despite a restrictive process umask", async () => {
    if (process.platform === "win32") return;
    const root = home();
    setupLegacy(root);
    chmodSync(configFile(root), 0o664);
    const previousUmask = process.umask(0o077);
    try {
      await install(root);

      expect(statSync(configFile(root)).mode & 0o777).toBe(0o664);
      expect(statSync(backupFile(root)).mode & 0o077).toBe(0);
    } finally {
      process.umask(previousUmask);
    }
  });

  it("logs the persistent backup path and removal guidance", async () => {
    const root = home();
    setupLegacy(root);
    const { log } = await install(root);

    expect(log).toHaveBeenCalledWith(expect.stringContaining(backupFile(root)));
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/may remove.*after validation/i),
    );
  });

  it("aborts when the fingerprint changes after lock acquisition", async () => {
    const root = home();
    writeConfig(root, "[features]\nhooks = true\n");
    faults.replaceOnSecondRead = "[features]\nhooks = true\n# edit\n";
    expect((await install(root)).result.status).toBe("skipped");
    expect(existsSync(recordFile(root))).toBe(false);
    expect(existsSync(lockFile(root))).toBe(false);
  });

  it.each([
    ["young dead", 2_147_483_647, new Date().toISOString(), false],
    ["old live", process.pid, "2000-01-01T00:00:00.000Z", false],
    ["old dead", 2_147_483_647, "2000-01-01T00:00:00.000Z", true],
  ])(
    "handles a %s lock conservatively",
    async (_name, pid, createdAt, runs) => {
      const root = home();
      mkdirSync(join(root, ".shepherd", "hooks"), { recursive: true });
      writeFileSync(lockFile(root), JSON.stringify({ pid, createdAt }), "utf8");

      expect((await install(root)).result.status).toBe(
        runs ? "installed" : "skipped",
      );
      expect(existsSync(lockFile(root))).toBe(!runs);
    },
  );

  it("writes durable config before the record", async () => {
    const root = home();
    setupLegacy(root);
    await install(root);
    const configSync = faults.events.findIndex(
      (event) => event.startsWith("fsync:") && event.includes(".config.toml."),
    );
    const recordRename = faults.events.indexOf("rename:" + recordFile(root));
    expect(configSync).toBeGreaterThanOrEqual(0);
    expect(recordRename).toBeGreaterThan(configSync);
  });

  it("permits an identical backup retry and rejects a mismatch", async () => {
    for (const matches of [true, false]) {
      const root = home();
      const source = setupLegacy(root);
      mkdirSync(join(root, ".shepherd", "hooks", "backups"), {
        recursive: true,
      });
      writeFileSync(backupFile(root), matches ? source : "different", "utf8");
      expect((await install(root)).result.status).toBe(
        matches ? "installed" : "skipped",
      );
    }
  });

  it("is idempotent and serializes racing public calls", async () => {
    const root = home();
    setupLegacy(root);
    const results = await Promise.all([install(root), install(root)]);
    expect(
      results.filter(({ result }) => result.status === "installed"),
    ).toHaveLength(1);
    const config = readFileSync(configFile(root), "utf8");
    expect((await install(root)).result.status).toBe("already-attempted");
    expect(readFileSync(configFile(root), "utf8")).toBe(config);
  });

  it("does not advance on backup failure or while disabled", async () => {
    const root = home();
    const source = setupLegacy(root);
    const record = readFileSync(recordFile(root), "utf8");
    mkdirSync(backupFile(root), { recursive: true });
    expect((await install(root)).result.status).toBe("skipped");
    expect(readFileSync(recordFile(root), "utf8")).toBe(record);
    expect(readFileSync(configFile(root), "utf8")).toBe(source);

    const disabledHome = home();
    setupLegacy(disabledHome);
    expect((await install(disabledHome, vi.fn(), true)).result.status).toBe(
      "disabled",
    );
  });
});
