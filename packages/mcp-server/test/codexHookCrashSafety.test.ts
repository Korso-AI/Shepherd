import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { autoInstallHooks } from "../src/hookInstall.js";

const faults = vi.hoisted(() => ({
  configReads: 0,
  denyConfigReopenOnce: false,
  failDirectoryFsyncOnce: null as string | null,
  replaceStaleBeforeQuarantine: null as string | null,
  replaceLockOnSecondConfigRead: null as string | null,
  failBackupLinkOnce: false,
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
        if (
          faults.configReads === 2 &&
          faults.replaceLockOnSecondConfigRead !== null
        ) {
          fs.writeFileSync(
            join(
              dirname(dirname(path)),
              ".shepherd",
              "hooks",
              "codex-migration-v2.lock",
            ),
            faults.replaceLockOnSecondConfigRead,
            "utf8",
          );
        }
      }
      return fs.readFileSync(...args);
    },
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const path = String(args[0]);
      if (
        faults.denyConfigReopenOnce &&
        path.endsWith("config.toml") &&
        args[1] === "r+"
      ) {
        faults.denyConfigReopenOnce = false;
        throw Object.assign(new Error("read-only config"), { code: "EACCES" });
      }
      const descriptor = fs.openSync(...args);
      faults.descriptors.set(descriptor, path);
      return descriptor;
    },
    fsyncSync: (descriptor: number) => {
      const path = faults.descriptors.get(descriptor) ?? "";
      faults.events.push("fsync:" + path);
      if (
        faults.failDirectoryFsyncOnce !== null &&
        path.endsWith(faults.failDirectoryFsyncOnce)
      ) {
        faults.failDirectoryFsyncOnce = null;
        throw new Error("injected directory fsync failure");
      }
      return fs.fsyncSync(descriptor);
    },
    closeSync: (descriptor: number) => {
      faults.descriptors.delete(descriptor);
      return fs.closeSync(descriptor);
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      const source = String(args[0]);
      const target = String(args[1]);
      faults.events.push("rename:" + source + "->" + target);
      if (
        target.includes(".quarantine-") &&
        faults.replaceStaleBeforeQuarantine !== null
      ) {
        fs.writeFileSync(source, faults.replaceStaleBeforeQuarantine, "utf8");
        faults.replaceStaleBeforeQuarantine = null;
      }
      return fs.renameSync(...args);
    },
    linkSync: (...args: Parameters<typeof fs.linkSync>) => {
      faults.events.push("link:" + String(args[0]) + "->" + String(args[1]));
      if (faults.failBackupLinkOnce) {
        faults.failBackupLinkOnce = false;
        throw new Error("injected backup publication failure");
      }
      return fs.linkSync(...args);
    },
  };
});

beforeEach(() => {
  faults.configReads = 0;
  faults.denyConfigReopenOnce = false;
  faults.failDirectoryFsyncOnce = null;
  faults.replaceStaleBeforeQuarantine = null;
  faults.replaceLockOnSecondConfigRead = null;
  faults.failBackupLinkOnce = false;
  faults.events.length = 0;
  faults.descriptors.clear();
});

const COMMENT =
  "# Added by Shepherd: delivers teammate announcements to the agent. Remove to disable.";

function home(): string {
  return mkdtempSync(join(tmpdir(), "shepherd-codex-crash-"));
}
function configFile(root: string): string {
  return join(root, ".codex", "config.toml");
}
function hooksDir(root: string): string {
  return join(root, ".shepherd", "hooks");
}
function recordFile(root: string): string {
  return join(hooksDir(root), "codex.json");
}
function lockFile(root: string): string {
  return join(hooksDir(root), "codex-migration-v2.lock");
}
function backupFile(root: string): string {
  return join(hooksDir(root), "backups", "codex-config-before-v2.toml");
}
function legacyConfig(): string {
  return [
    "[features]",
    "hooks = true",
    "",
    COMMENT,
    "[[hooks.UserPromptSubmit]]",
    'command = ["npx", "-y", "--package=@korso/shepherd@0.11.1", "shepherd-inbox-hook"]',
    "",
  ].join("\n");
}
function setupLegacy(root: string): { config: Buffer; record: Buffer } {
  mkdirSync(join(root, ".codex"), { recursive: true });
  mkdirSync(hooksDir(root), { recursive: true });
  const config = Buffer.from(legacyConfig());
  const record = Buffer.from(
    JSON.stringify({ status: "installed", at: "2026-07-03T00:00:00.000Z" }) +
      "\n",
  );
  writeFileSync(configFile(root), config);
  writeFileSync(recordFile(root), record);
  return { config, record };
}
async function install(root: string) {
  return autoInstallHooks({
    clientName: "codex",
    homeDir: root,
    hookScriptSource: join(root, "missing.js"),
    log: vi.fn(),
  });
}
function lock(owner = "owner", createdAt = new Date().toISOString()): string {
  return JSON.stringify({ pid: process.pid, createdAt, owner });
}

describe("Codex atomic replacement durability", () => {
  it("migrates read-only config without a post-rename reopen", async () => {
    if (process.platform === "win32") return;
    const root = home();
    const original = setupLegacy(root);
    faults.denyConfigReopenOnce = true;

    expect((await install(root)).status).toBe("installed");
    expect(
      readFileSync(configFile(root)).subarray(0, original.config.length),
    ).toEqual(original.config);
    expect(JSON.parse(readFileSync(recordFile(root), "utf8"))).toMatchObject({
      migrationOutcome: "migrated",
    });
  });

  it("rolls back config and record when config parent fsync fails", async () => {
    if (process.platform === "win32") return;
    const root = home();
    const original = setupLegacy(root);
    faults.failDirectoryFsyncOnce = join(root, ".codex");

    expect((await install(root)).status).toBe("skipped");
    expect(readFileSync(configFile(root))).toEqual(original.config);
    expect(readFileSync(recordFile(root))).toEqual(original.record);
  });

  it("fsyncs parent directories after durable renames on POSIX", async () => {
    if (process.platform === "win32") return;
    const root = home();
    setupLegacy(root);

    expect((await install(root)).status).toBe("installed");
    expect(faults.events).toContain("fsync:" + dirname(configFile(root)));
    expect(faults.events).toContain("fsync:" + dirname(recordFile(root)));
  });
});

describe("Codex migration lock ownership", () => {
  it("reclaims stale malformed locks by mtime but holds fresh malformed locks", async () => {
    for (const malformed of [
      "{truncated",
      JSON.stringify({ pid: process.pid, createdAt: "not-a-date" }),
    ]) {
      for (const stale of [false, true]) {
        const root = home();
        mkdirSync(hooksDir(root), { recursive: true });
        writeFileSync(lockFile(root), malformed, "utf8");
        if (stale) {
          const old = new Date("2000-01-01T00:00:00.000Z");
          utimesSync(lockFile(root), old, old);
        }
        expect((await install(root)).status).toBe(
          stale ? "installed" : "skipped",
        );
        expect(existsSync(lockFile(root))).toBe(!stale);
      }
    }
  });

  it("allows only one claimant to quarantine a stale lock", async () => {
    const root = home();
    mkdirSync(hooksDir(root), { recursive: true });
    writeFileSync(
      lockFile(root),
      JSON.stringify({
        pid: 2_147_483_647,
        createdAt: "2000-01-01T00:00:00.000Z",
        owner: "dead",
      }),
      "utf8",
    );

    const results = await Promise.all([install(root), install(root)]);

    expect(results.filter(({ status }) => status === "installed")).toHaveLength(
      1,
    );
    expect(faults.events.some((event) => event.includes(".quarantine-"))).toBe(
      true,
    );
    expect(
      readdirSync(hooksDir(root)).some((name) => name.includes(".quarantine-")),
    ).toBe(false);
  });

  it("does not reclaim a fresh lock that replaced the stale snapshot", async () => {
    const root = home();
    mkdirSync(hooksDir(root), { recursive: true });
    writeFileSync(
      lockFile(root),
      JSON.stringify({
        pid: 2_147_483_647,
        createdAt: "2000-01-01T00:00:00.000Z",
        owner: "dead",
      }),
      "utf8",
    );
    const replacement = lock("replacement");
    faults.replaceStaleBeforeQuarantine = replacement;

    expect((await install(root)).status).toBe("skipped");
    expect(readFileSync(lockFile(root), "utf8")).toBe(replacement);
  });

  it("releases a lock only while its owner token still matches", async () => {
    const root = home();
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(configFile(root), "[features]\nhooks = true\n", "utf8");
    const replacement = lock("replacement");
    faults.replaceLockOnSecondConfigRead = replacement;

    await install(root);

    expect(readFileSync(lockFile(root), "utf8")).toBe(replacement);
    unlinkSync(lockFile(root));
  });
});

describe("Codex backup publication and byte boundaries", () => {
  it("cleans its temp and leaves no permanent backup when publication fails", async () => {
    const root = home();
    const original = setupLegacy(root);
    faults.failBackupLinkOnce = true;

    expect((await install(root)).status).toBe("skipped");
    expect(existsSync(backupFile(root))).toBe(false);
    const backups = dirname(backupFile(root));
    expect(existsSync(backups) ? readdirSync(backups) : []).toEqual([]);
    expect(readFileSync(configFile(root))).toEqual(original.config);
  });

  it("publishes with create-if-absent semantics", async () => {
    const root = home();
    const original = setupLegacy(root);

    expect((await install(root)).status).toBe("installed");
    expect(readFileSync(backupFile(root))).toEqual(original.config);
    expect(faults.events.some((event) => event.startsWith("link:"))).toBe(true);
  });

  it("leaves invalid UTF-8 bytes untouched as unsupported shape", async () => {
    const root = home();
    mkdirSync(join(root, ".codex"), { recursive: true });
    const invalid = Buffer.concat([
      Buffer.from("[features]\nhooks = true\n# invalid "),
      Buffer.from([0xff]),
      Buffer.from("\n"),
    ]);
    writeFileSync(configFile(root), invalid);

    expect((await install(root)).status).toBe("skipped");
    expect(readFileSync(configFile(root))).toEqual(invalid);
    expect(JSON.parse(readFileSync(recordFile(root), "utf8"))).toMatchObject({
      migrationVersion: 2,
      migrationOutcome: "unsupported-shape",
    });
  });
});
