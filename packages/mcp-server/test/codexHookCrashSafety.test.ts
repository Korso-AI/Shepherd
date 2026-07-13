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
  replaceStaleBeforeClaimVerification: null as string | null,
  replaceLockOnSecondConfigRead: null as string | null,
  failBackupLinkOnce: false,
  failLockCreationOnce: null as null | {
    stage: "write" | "fsync";
    target: "main" | "reclaim";
  },
  onLockPublication: null as ((target: string) => void) | null,
  onLockMutation: null as (() => void) | null,
  watchedMigrationLock: null as string | null,
  observedUnlockedMigration: false,
  events: [] as string[],
  descriptors: new Map<number, string>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const isLockTarget = (path: string, target: "main" | "reclaim") =>
    path.includes("codex-migration-v2.lock") &&
    (target === "reclaim"
      ? path.includes(".reclaim")
      : !path.includes(".reclaim"));
  return {
    ...fs,
    existsSync: (...args: Parameters<typeof fs.existsSync>) => {
      const path = String(args[0]);
      if (
        path.endsWith("config.toml") &&
        faults.watchedMigrationLock !== null &&
        !fs.existsSync(faults.watchedMigrationLock)
      ) {
        faults.observedUnlockedMigration = true;
      }
      return fs.existsSync(...args);
    },
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      const path = String(args[0]);
      if (
        path.endsWith("codex-migration-v2.lock.reclaim") &&
        faults.replaceStaleBeforeClaimVerification !== null
      ) {
        fs.writeFileSync(
          path.slice(0, -".reclaim".length),
          faults.replaceStaleBeforeClaimVerification,
          "utf8",
        );
        faults.replaceStaleBeforeClaimVerification = null;
      }
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
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      const path =
        typeof args[0] === "number"
          ? (faults.descriptors.get(args[0]) ?? "")
          : String(args[0]);
      const failure = faults.failLockCreationOnce;
      if (failure?.stage === "write" && isLockTarget(path, failure.target)) {
        faults.failLockCreationOnce = null;
        throw new Error("injected lock write failure");
      }
      return fs.writeFileSync(...args);
    },
    fsyncSync: (descriptor: number) => {
      const path = faults.descriptors.get(descriptor) ?? "";
      faults.events.push("fsync:" + path);
      const lockFailure = faults.failLockCreationOnce;
      if (
        lockFailure?.stage === "fsync" &&
        isLockTarget(path, lockFailure.target)
      ) {
        faults.failLockCreationOnce = null;
        throw new Error("injected lock fsync failure");
      }
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
      const opensGap =
        source.endsWith("codex-migration-v2.lock") &&
        target.includes(".quarantine-");
      if (!opensGap && target.endsWith("codex-migration-v2.lock")) {
        faults.onLockMutation?.();
      }
      const result = fs.renameSync(...args);
      if (opensGap) faults.onLockMutation?.();
      return result;
    },
    linkSync: (...args: Parameters<typeof fs.linkSync>) => {
      const target = String(args[1]);
      faults.events.push("link:" + String(args[0]) + "->" + target);
      if (target.includes("codex-migration-v2.lock")) {
        faults.onLockPublication?.(target);
      }
      const isBackup = target.endsWith("codex-config-before-v2.toml");
      if (faults.failBackupLinkOnce && isBackup) {
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
  faults.replaceStaleBeforeClaimVerification = null;
  faults.replaceLockOnSecondConfigRead = null;
  faults.failBackupLinkOnce = false;
  faults.failLockCreationOnce = null;
  faults.onLockPublication = null;
  faults.onLockMutation = null;
  faults.watchedMigrationLock = null;
  faults.observedUnlockedMigration = false;
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
function reclaimFile(root: string): string {
  return lockFile(root) + ".reclaim";
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
function lock(
  owner = "owner",
  createdAt = new Date().toISOString(),
  pid = process.pid,
): string {
  return JSON.stringify({ pid, createdAt, owner });
}
function deadLock(owner = "dead"): string {
  return lock(owner, "2000-01-01T00:00:00.000Z", 2_147_483_647);
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
  it("requires a recorded dead PID before reclaiming malformed locks", async () => {
    const cases = [
      ["{truncated", false],
      [JSON.stringify({ createdAt: "not-a-date" }), false],
      [JSON.stringify({ pid: process.pid, createdAt: "not-a-date" }), false],
      [
        JSON.stringify({
          pid: 2_147_483_647,
          createdAt: "not-a-date",
        }),
        true,
      ],
    ] as const;
    for (const [malformed, reclaimable] of cases) {
      const root = home();
      mkdirSync(hooksDir(root), { recursive: true });
      writeFileSync(lockFile(root), malformed, "utf8");
      const old = new Date("2000-01-01T00:00:00.000Z");
      utimesSync(lockFile(root), old, old);
      expect((await install(root)).status).toBe(
        reclaimable ? "installed" : "skipped",
      );
      expect(existsSync(lockFile(root))).toBe(!reclaimable);
    }
  });
  it("publishes no lock path when ownership write or fsync fails", async () => {
    for (const target of ["main", "reclaim"] as const) {
      for (const stage of ["write", "fsync"] as const) {
        const root = home();
        mkdirSync(hooksDir(root), { recursive: true });
        if (target === "reclaim") {
          writeFileSync(lockFile(root), deadLock(), "utf8");
        }
        faults.failLockCreationOnce = { stage, target };
        expect.soft((await install(root)).status).toBe("skipped");
        expect
          .soft(
            existsSync(target === "main" ? lockFile(root) : reclaimFile(root)),
          )
          .toBe(false);
        expect
          .soft(
            readdirSync(hooksDir(root)).some((name) =>
              name.includes(".owner-"),
            ),
          )
          .toBe(false);
        expect.soft((await install(root)).status).toBe("installed");
      }
    }
  });
  it("recovers recorded-dead reclaim claims but holds malformed claims", async () => {
    for (const [claim, expected] of [
      [deadLock("claim"), "installed"],
      ["{truncated", "skipped"],
    ] as const) {
      const root = home();
      mkdirSync(hooksDir(root), { recursive: true });
      writeFileSync(lockFile(root), deadLock(), "utf8");
      writeFileSync(reclaimFile(root), claim, "utf8");
      const old = new Date("2000-01-01T00:00:00.000Z");
      utimesSync(reclaimFile(root), old, old);
      expect((await install(root)).status).toBe(expected);
      expect(existsSync(reclaimFile(root))).toBe(true);
    }
  });
  it("cannot remove another owner during no-overwrite publication", async () => {
    for (const target of ["main", "reclaim"] as const) {
      const root = home();
      mkdirSync(hooksDir(root), { recursive: true });
      if (target === "reclaim") {
        writeFileSync(lockFile(root), deadLock(), "utf8");
      }
      const contenders: Array<ReturnType<typeof install>> = [];
      const publication =
        target === "main" ? lockFile(root) : reclaimFile(root);
      faults.onLockPublication = (published) => {
        if (published !== publication) return;
        faults.onLockPublication = null;
        contenders.push(install(root));
      };
      const primary = await install(root);
      expect(contenders).toHaveLength(1);
      if (contenders[0] === undefined) continue;
      const statuses = [primary.status, (await contenders[0]).status].sort();
      expect(statuses).toEqual(["installed", "skipped"]);
      expect(existsSync(lockFile(root))).toBe(false);
      expect(existsSync(reclaimFile(root))).toBe(false);
    }
  });

  it("serializes a claimant that already validated the stale reclaim claim", async () => {
    const root = home();
    mkdirSync(hooksDir(root), { recursive: true });
    writeFileSync(lockFile(root), deadLock(), "utf8");
    const validatedClaim = deadLock("claim");
    writeFileSync(reclaimFile(root), validatedClaim, "utf8");
    const contenders: Array<ReturnType<typeof install>> = [];
    faults.onLockMutation = () => {
      faults.onLockMutation = null;
      // Replay the claim snapshot a contender validated before this claimant
      // replaced it, then let that contender resume its acquisition.
      writeFileSync(reclaimFile(root), validatedClaim, "utf8");
      faults.watchedMigrationLock = lockFile(root);
      contenders.push(install(root));
    };
    const primary = await install(root);
    expect(contenders).toHaveLength(1);
    const contender = await contenders[0]!;
    expect.soft(primary.status).toBe("installed");
    expect.soft(contender.status).toBe("skipped");
    expect(faults.observedUnlockedMigration).toBe(false);
  });
  it("does not reclaim a fresh lock that replaced the stale snapshot", async () => {
    const root = home();
    mkdirSync(hooksDir(root), { recursive: true });
    writeFileSync(lockFile(root), deadLock(), "utf8");
    const replacement = lock("replacement");
    faults.replaceStaleBeforeClaimVerification = replacement;
    expect((await install(root)).status).toBe("skipped");
    expect(readFileSync(lockFile(root), "utf8")).toBe(replacement);
  });
  it("keeps a third claimant out while atomically replacing a stale lock", async () => {
    const root = home();
    mkdirSync(hooksDir(root), { recursive: true });
    writeFileSync(lockFile(root), deadLock(), "utf8");
    const contenders: Array<ReturnType<typeof install>> = [];
    faults.onLockMutation = () => {
      faults.onLockMutation = null;
      contenders.push(install(root));
    };
    const primary = await install(root);
    expect(contenders).toHaveLength(1);
    const contender = await contenders[0]!;
    expect(primary.status).toBe("installed");
    expect(contender.status).toBe("skipped");
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

  it("re-establishes backup directory durability on retry", async () => {
    if (process.platform === "win32") return;
    const root = home();
    setupLegacy(root);
    const backups = dirname(backupFile(root));
    faults.failDirectoryFsyncOnce = backups;
    expect((await install(root)).status).toBe("skipped");
    expect(existsSync(backupFile(root))).toBe(true);
    faults.events.length = 0;
    expect((await install(root)).status).toBe("installed");
    expect(faults.events).toContain("fsync:" + backups);
  });

  it("fsyncs hooks when first publishing the backups directory", async () => {
    if (process.platform === "win32") return;
    const root = home();
    setupLegacy(root);
    expect((await install(root)).status).toBe("installed");
    const hooksSync = faults.events.indexOf("fsync:" + hooksDir(root));
    const configRename = faults.events.findIndex(
      (event) =>
        event.startsWith("rename:") && event.endsWith("->" + configFile(root)),
    );
    expect(hooksSync).toBeGreaterThanOrEqual(0);
    expect(configRename).toBeGreaterThan(hooksSync);
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
